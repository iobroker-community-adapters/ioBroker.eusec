import { expect } from 'chai';
import http from 'node:http';
import stream from 'node:stream';

import {
    OnDemandStreams,
    busyReason,
    unreachableReason,
    findAdtsStart,
    findKeyframeStart,
    onDemandSource,
    parseOnDemandPath,
    startUntilDelivered,
} from './ondemand';

const silent = { debug: (): void => {}, info: (): void => {}, warn: (): void => {} };
const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/**
 * A start hook that behaves like startUntilDelivered(): it runs until the livestream arrived or
 * nobody waits for it anymore.
 */
const untilDelivered =
    (streams: () => OnDemandStreams) =>
    (serial: string): Promise<void> =>
        new Promise(resolve => {
            const timer = setInterval(() => {
                if (!streams().isWaiting(serial)) {
                    clearInterval(timer);
                    resolve();
                }
            }, 10);
        });
/** A keyframe as the camera sends it: start code, SPS header byte, then the payload. */
const keyframe = (payload: string): Buffer => Buffer.concat([Buffer.from([0, 0, 0, 1, 0x67]), Buffer.from(payload)]);
/** An ADTS frame: sync word, then the payload. */
const adts = (payload: string): Buffer => Buffer.concat([Buffer.from([0xff, 0xf1]), Buffer.from(payload)]);

interface Pull {
    request: http.ClientRequest;
    response: Promise<http.IncomingMessage>;
    data: () => string;
}

/** Opens a source the way go2rtc does and collects what arrives. */
const pull = (url: string): Pull => {
    let data = '';
    let request!: http.ClientRequest;
    const response = new Promise<http.IncomingMessage>((resolve, reject) => {
        request = http.get(url, res => {
            res.setEncoding('utf8');
            res.on('data', (chunk: string) => (data += chunk));
            resolve(res);
        });
        request.on('error', reject);
    });
    // Tests that abort a request on purpose do not wait for its answer.
    response.catch(() => {});
    return { request, response, data: () => data };
};

describe('ondemand => parseOnDemandPath', () => {
    it('should accept the paths built by onDemandSource()', () => {
        const url = new URL(onDemandSource(1234, 'T8134520241455AC', 'audio'));
        expect(parseOnDemandPath(url.pathname)).to.deep.equal({ serial: 'T8134520241455AC', track: 'audio' });
    });

    it('should reject anything else', () => {
        expect(parseOnDemandPath('/T8134520241455AC/picture')).to.equal(undefined);
        expect(parseOnDemandPath('/../video')).to.equal(undefined);
        expect(parseOnDemandPath('/T81/video/more')).to.equal(undefined);
        expect(parseOnDemandPath(undefined)).to.equal(undefined);
    });
});

describe('ondemand => OnDemandStreams', () => {
    let streams: OnDemandStreams;
    let started: string[];
    let stopped: string[];

    const create = async (options = {}, group?: (serial: string) => string | undefined): Promise<number> => {
        started = [];
        stopped = [];
        streams = new OnDemandStreams(
            {
                start: serial => {
                    started.push(serial);
                    return untilDelivered(() => streams)(serial);
                },
                stop: serial => Promise.resolve(void stopped.push(serial)),
                group,
                log: silent,
            },
            { idleStopDelay: 300, firstDataTimeout: 1500, audioTimeout: 100, ...options },
        );
        return streams.listen();
    };

    afterEach(async () => {
        await streams.close();
    });

    it('should start the livestream on the first request and deliver what the camera sends', async () => {
        await create();
        const [videoUrl, audioUrl] = streams.sources('CAM1');
        const video = pull(videoUrl);
        const audio = pull(audioUrl);
        await wait(50);
        expect(started).to.deep.equal(['CAM1']);

        const cameraVideo = new stream.PassThrough();
        const cameraAudio = new stream.PassThrough();
        streams.attach('CAM1', cameraVideo, cameraAudio);
        cameraVideo.write(keyframe('frame'));
        cameraAudio.write(adts('sound'));

        expect((await video.response).statusCode).to.equal(200);
        expect((await audio.response).statusCode).to.equal(200);
        await wait(50);
        expect(video.data()).to.contain('frame');
        expect(audio.data()).to.contain('sound');
    });

    it('should send the header only once data is there, even when the camera takes long', async () => {
        await create();
        const video = pull(streams.sources('CAM1')[0]);
        let answered = false;
        void video.response.then(() => (answered = true));
        await wait(100);
        expect(answered).to.equal(false);

        const cameraVideo = new stream.PassThrough();
        streams.attach('CAM1', cameraVideo, new stream.PassThrough());
        cameraVideo.write(keyframe('late'));
        expect((await video.response).statusCode).to.equal(200);
    });

    it('should stop the livestream once nobody watched it for the grace period', async () => {
        await create();
        const video = pull(streams.sources('CAM1')[0]);
        await wait(50);
        const cameraVideo = new stream.PassThrough();
        streams.attach('CAM1', cameraVideo, new stream.PassThrough());
        cameraVideo.write(keyframe('frame'));
        await video.response;

        video.request.destroy();
        await wait(50);
        expect(stopped).to.deep.equal([]);
        await wait(400);
        expect(stopped).to.deep.equal(['CAM1']);
    });

    it('should keep the livestream when go2rtc comes back within the grace period', async () => {
        await create({ idleStopDelay: 400 });
        const first = pull(streams.sources('CAM1')[0]);
        await wait(50);
        const cameraVideo = new stream.PassThrough();
        streams.attach('CAM1', cameraVideo, new stream.PassThrough());
        cameraVideo.write(keyframe('frame'));
        await first.response;
        first.request.destroy();
        await wait(50);

        const second = pull(streams.sources('CAM1')[0]);
        await wait(50);
        cameraVideo.write(keyframe('more'));
        expect((await second.response).statusCode).to.equal(200);
        await wait(600);
        expect(stopped).to.deep.equal([]);
        expect(started).to.deep.equal(['CAM1']);
        second.request.destroy();
    });

    it('should not stop a livestream that nobody requested, e.g. one started for talkback', async () => {
        await create();
        const cameraVideo = new stream.PassThrough();
        streams.attach('CAM1', cameraVideo, new stream.PassThrough());
        cameraVideo.write(keyframe('frame'));
        await wait(400);
        expect(stopped).to.deep.equal([]);
        expect(cameraVideo.readableFlowing).to.equal(true);
    });

    it('should end the requests when the livestream stops, so go2rtc reconnects', async () => {
        await create();
        const video = pull(streams.sources('CAM1')[0]);
        await wait(50);
        const cameraVideo = new stream.PassThrough();
        streams.attach('CAM1', cameraVideo, new stream.PassThrough());
        cameraVideo.write(keyframe('frame'));
        const response = await video.response;
        const ended = new Promise(resolve => response.on('end', resolve));
        streams.detach('CAM1');
        await ended;

        pull(streams.sources('CAM1')[0]);
        await wait(50);
        expect(started).to.deep.equal(['CAM1', 'CAM1']);
    });

    it('should give up on audio of a mute camera, so the video is not held back', async () => {
        await create();
        const [videoUrl, audioUrl] = streams.sources('CAM1');
        const audio = pull(audioUrl);
        await wait(50);
        const cameraVideo = new stream.PassThrough();
        streams.attach('CAM1', cameraVideo, new stream.PassThrough());
        cameraVideo.write(keyframe('frame'));
        expect((await audio.response).statusCode).to.equal(404);

        // Every further consumer learns it right away instead of waiting again.
        const again = pull(audioUrl);
        expect((await again.response).statusCode).to.equal(404);
        pull(videoUrl).request.destroy();
    });

    it('should answer 504 when the camera never delivers, and try again on the next request', async () => {
        await create({ firstDataTimeout: 100 });
        const video = pull(streams.sources('CAM1')[0]);
        expect((await video.response).statusCode).to.equal(504);
        await wait(50);
        pull(streams.sources('CAM1')[0]);
        await wait(50);
        expect(started).to.deep.equal(['CAM1', 'CAM1']);
    });

    it('should not start a second time while a start still runs, also after a 504', async () => {
        let finish!: () => void;
        const starts: string[] = [];
        const streams = new OnDemandStreams(
            {
                // A start whose retries take longer than firstDataTimeout.
                start: serial => {
                    starts.push(serial);
                    return new Promise<void>(resolve => (finish = resolve));
                },
                stop: () => Promise.resolve(),
                log: silent,
            },
            { idleStopDelay: 300, firstDataTimeout: 100, audioTimeout: 100 },
        );
        await streams.listen();
        try {
            expect((await pull(streams.sources('CAM1')[0]).response).statusCode).to.equal(504);
            const again = pull(streams.sources('CAM1')[0]);
            await wait(30);
            expect(starts).to.deep.equal(['CAM1']);

            // The running start delivers to the request that came after the 504.
            const cameraVideo = new stream.PassThrough();
            streams.attach('CAM1', cameraVideo, new stream.PassThrough());
            cameraVideo.write(keyframe('frame'));
            expect((await again.response).statusCode).to.equal(200);
            finish();
            again.request.destroy();

            // Once it ended, the next request starts again.
            streams.detach('CAM1');
            await wait(20);
            pull(streams.sources('CAM1')[0]);
            await wait(30);
            expect(starts).to.deep.equal(['CAM1', 'CAM1']);
            finish();
        } finally {
            await streams.close();
        }
    });

    it('should drop data for a reader that does not keep up, and go on at the next keyframe', async () => {
        const debugs: string[] = [];
        const streams: OnDemandStreams = new OnDemandStreams(
            {
                start: untilDelivered(() => streams),
                stop: () => Promise.resolve(),
                log: { ...silent, debug: message => void debugs.push(message) },
            },
            { idleStopDelay: 300, firstDataTimeout: 1500, audioTimeout: 100 },
        );
        await streams.listen();
        try {
            let received = 0;
            let first: Buffer | undefined;
            let response!: http.IncomingMessage;
            const answered = new Promise<void>(resolve => {
                http.get(streams.sources('CAM1')[0], res => {
                    response = res;
                    // Reads nothing until resumed - like a go2rtc that got stuck.
                    res.pause();
                    resolve();
                });
            });
            await wait(50);
            const cameraVideo = new stream.PassThrough();
            streams.attach('CAM1', cameraVideo, new stream.PassThrough());
            const chunk = Buffer.concat([keyframe('x'), Buffer.alloc(64 * 1024, 7)]);
            cameraVideo.write(chunk);
            await answered;
            // 64 MB that a stuck reader would otherwise hold in memory.
            for (let i = 0; i < 1024; i++) {
                cameraVideo.write(chunk);
                if (i % 64 === 0) {
                    await wait(1);
                }
            }
            await wait(50);
            expect(debugs.some(message => message.includes('dropping data'))).to.equal(true);

            response.on('data', (data: Buffer) => {
                first ??= data;
                received += data.length;
            });
            response.resume();
            await wait(100);
            cameraVideo.write(Buffer.concat([Buffer.from('tail'), keyframe('next')]));
            await wait(100);
            expect(received).to.be.greaterThan(0);
            expect(received).to.be.lessThan(1025 * chunk.length);
            expect([...first!.subarray(0, 5)]).to.deep.equal([0, 0, 0, 1, 0x67]);
            response.destroy();
        } finally {
            await streams.close();
        }
    });

    it('should report a waiting request until the livestream arrives', async () => {
        await create();
        expect(streams.isWaiting('CAM1')).to.equal(false);
        const video = pull(streams.sources('CAM1')[0]);
        await wait(50);
        expect(streams.isWaiting('CAM1')).to.equal(true);

        const cameraVideo = new stream.PassThrough();
        streams.attach('CAM1', cameraVideo, new stream.PassThrough());
        expect(streams.isWaiting('CAM1')).to.equal(false);
        video.request.destroy();
    });

    it('should not start a second device of a station while the first one is watched', async () => {
        await create({}, () => 'STATION');
        const first = pull(streams.sources('CAM1')[0]);
        await wait(50);
        const second = pull(streams.sources('CAM2')[0]);
        expect((await second.response).statusCode).to.equal(503);
        expect(started).to.deep.equal(['CAM1']);
        first.request.destroy();
    });

    it('should log a refusal once, not for every attempt of go2rtc', async () => {
        const infos: string[] = [];
        const streams: OnDemandStreams = new OnDemandStreams(
            {
                start: untilDelivered(() => streams),
                stop: () => Promise.resolve(),
                group: () => 'STATION',
                log: { ...silent, info: message => void infos.push(message) },
            },
            { idleStopDelay: 300, firstDataTimeout: 1500, audioTimeout: 100 },
        );
        await streams.listen();
        try {
            const first = pull(streams.sources('CAM1')[0]);
            await wait(50);
            for (const url of [...streams.sources('CAM2'), ...streams.sources('CAM2')]) {
                await pull(url).response;
            }
            expect(infos.filter(message => message.includes('busy'))).to.have.length(1);
            first.request.destroy();
        } finally {
            await streams.close();
        }
    });

    it('should name the watched device in the answer go2rtc hands on to the player', async () => {
        const streams: OnDemandStreams = new OnDemandStreams(
            {
                start: untilDelivered(() => streams),
                stop: () => Promise.resolve(),
                group: () => 'STATION',
                name: serial => (serial === 'CAM1' ? 'Garten Pool' : 'Haustür'),
                log: silent,
            },
            { idleStopDelay: 300, firstDataTimeout: 1500, audioTimeout: 100 },
        );
        await streams.listen();
        try {
            const first = pull(streams.sources('CAM1')[0]);
            await wait(50);
            const second = await pull(streams.sources('CAM2')[0]).response;
            expect(second.statusCode).to.equal(503);
            expect(second.statusMessage).to.equal('Station busy - Garten Pool is streaming');
            first.request.destroy();
        } finally {
            await streams.close();
        }
    });

    it('should keep the busy reason within what HTTP allows', () => {
        expect(busyReason('Haustür Weg')).to.equal('Station busy - Haustuer Weg is streaming');
        expect(busyReason('Kamera 📷')).to.equal('Station busy - Kamera is streaming');
        expect(busyReason('')).to.equal('Station busy - another device is streaming');
        expect(unreachableReason('Türklingel')).to.equal('Camera not reachable - Tuerklingel');
    });

    it('should hand the station over quickly when another device waits for it', async () => {
        await create({ idleStopDelay: 2000, handoverDelay: 50 }, () => 'STATION');
        const first = pull(streams.sources('CAM1')[0]);
        await wait(50);
        expect((await pull(streams.sources('CAM2')[0]).response).statusCode).to.equal(503);
        first.request.destroy();
        await wait(300);
        expect(stopped).to.deep.equal(['CAM1']);
    });

    it('should not let a start that never delivers keep the station for good', async () => {
        await create({ startBlock: 100 }, () => 'STATION');
        const first = pull(streams.sources('CAM1')[0]);
        await wait(50);
        expect(streams.stationBusyWith('CAM2')).to.equal('CAM1');
        await wait(100);
        expect(streams.stationBusyWith('CAM2')).to.equal(undefined);
        first.request.destroy();
    });

    it('should answer right away for a camera whose start attempts failed, and free its station', async () => {
        await create({ unreachableFor: 200 }, () => 'STATION');
        const waiting = pull(streams.sources('CAM1')[0]);
        await wait(50);
        streams.markUnreachable('CAM1');
        const answer = await waiting.response;
        expect(answer.statusCode).to.equal(503);
        expect(answer.statusMessage).to.equal('Camera not reachable - CAM1');
        expect(streams.stationBusyWith('CAM2')).to.equal(undefined);

        expect((await pull(streams.sources('CAM1')[0]).response).statusCode).to.equal(503);
        expect(started).to.deep.equal(['CAM1']);
        await wait(250);
        pull(streams.sources('CAM1')[0]);
        await wait(50);
        expect(started).to.deep.equal(['CAM1', 'CAM1']);
    });

    it('should tell start_stream which watched device keeps the station busy', async () => {
        await create({}, serial => (serial === 'CAM3' ? 'OTHER' : 'STATION'));
        expect(streams.stationBusyWith('CAM2')).to.equal(undefined);
        const first = pull(streams.sources('CAM1')[0]);
        await wait(50);
        expect(streams.stationBusyWith('CAM2')).to.equal('CAM1');
        expect(streams.stationBusyWith('CAM1')).to.equal(undefined);
        expect(streams.stationBusyWith('CAM3')).to.equal(undefined);
        first.request.destroy();
    });

    it('should start devices of different stations side by side', async () => {
        await create({}, serial => (serial === 'CAM1' ? 'A' : 'B'));
        const first = pull(streams.sources('CAM1')[0]);
        const second = pull(streams.sources('CAM2')[0]);
        await wait(50);
        expect(started).to.have.members(['CAM1', 'CAM2']);
        first.request.destroy();
        second.request.destroy();
    });

    it('should let the next device of the station start once nobody watches the first one', async () => {
        await create({}, () => 'STATION');
        const first = pull(streams.sources('CAM1')[0]);
        await wait(50);
        first.request.destroy();
        await wait(50);
        pull(streams.sources('CAM2')[0]);
        await wait(50);
        expect(started).to.deep.equal(['CAM1', 'CAM2']);
    });

    it('should stop a start that never delivered once nobody waits for it anymore', async () => {
        await create();
        const video = pull(streams.sources('CAM1')[0]);
        await wait(50);
        expect(started).to.deep.equal(['CAM1']);
        video.request.destroy();
        await wait(400);
        expect(stopped).to.deep.equal(['CAM1']);
    });
});

describe('ondemand => joining a running livestream', () => {
    it('should begin the video at the start code of the next SPS', () => {
        const data = Buffer.from([0x03, 0xdb, 0x03, 0x84, 0, 0, 0, 1, 0x41, 9, 0, 0, 0, 1, 0x67, 1]);
        expect(findKeyframeStart(data)).to.equal(10);
    });

    it('should accept a three byte start code and an H.265 VPS', () => {
        expect(findKeyframeStart(Buffer.from([9, 9, 0, 0, 1, 0x67]))).to.equal(2);
        expect(findKeyframeStart(Buffer.from([0, 0, 0, 1, 0x40, 1]), true)).to.equal(0);
    });

    it('should wait for the next chunk when a chunk holds no keyframe', () => {
        expect(findKeyframeStart(Buffer.from([0x03, 0xdb, 0, 0, 0, 1, 0x41, 9]))).to.equal(-1);
    });

    it('should begin the audio at the next ADTS sync word', () => {
        expect(findAdtsStart(Buffer.from([0x12, 0x34, 0xff, 0xf1, 0x50]))).to.equal(2);
        expect(findAdtsStart(Buffer.from([0x12, 0x34]))).to.equal(-1);
    });

    it('should hand go2rtc nothing before the next keyframe of a running livestream', async () => {
        const streams: OnDemandStreams = new OnDemandStreams(
            { start: untilDelivered(() => streams), stop: () => Promise.resolve(), log: silent },
            { idleStopDelay: 300, firstDataTimeout: 1500, audioTimeout: 100 },
        );
        await streams.listen();
        try {
            const cameraVideo = new stream.PassThrough();
            streams.attach('CAM1', cameraVideo, new stream.PassThrough());
            cameraVideo.write(keyframe('before'));
            await wait(20);

            const video = pull(streams.sources('CAM1')[0]);
            await wait(50);
            // The middle of a frame, as the camera sends it - go2rtc would refuse it.
            cameraVideo.write(Buffer.from([0x03, 0xdb, 0x03, 0x84, 0x55]));
            cameraVideo.write(Buffer.concat([Buffer.from('tail'), keyframe('next')]));
            const response = await video.response;
            await wait(50);

            expect(response.statusCode).to.equal(200);
            const received = Buffer.from(video.data(), 'latin1');
            expect([...received.subarray(0, 5)]).to.deep.equal([0, 0, 0, 1, 0x67]);
            expect(video.data()).to.contain('next');
            expect(video.data()).not.to.contain('tail');
            video.request.destroy();
        } finally {
            await streams.close();
        }
    });
});

describe('ondemand => startUntilDelivered', () => {
    interface Camera {
        /** What isStreaming() answers, second by second - the last answer repeats. */
        streaming: boolean[];
        /** The second the livestream arrives at, if it does. */
        deliversAt?: number;
    }

    /**
     * Runs startUntilDelivered() against a simulated camera and clock: every sleep() advances the
     * clock by its duration, and every start() begins a new simulated attempt.
     */
    const simulate = async (
        attempts: Camera[],
        options: { waitingUntil?: number; streamingBefore?: number } = {},
    ): Promise<{ starts: number; stops: number; unreachable: boolean; seconds: number }> => {
        let seconds = 0;
        let startedAt = 0;
        let starts = 0;
        let stops = 0;
        let unreachable = false;
        let stopped = false;
        const current = (): Camera | undefined => attempts[starts - 1];
        await startUntilDelivered(
            'CAM1',
            {
                isStreaming: () => {
                    if (starts === 0) {
                        return Promise.resolve(seconds < (options.streamingBefore ?? 0));
                    }
                    if (stopped) {
                        return Promise.resolve(false);
                    }
                    const answers = current()!.streaming;
                    return Promise.resolve(answers[Math.min(seconds - startedAt, answers.length - 1)]);
                },
                start: () => {
                    starts++;
                    startedAt = seconds;
                    stopped = false;
                    return Promise.resolve();
                },
                stop: () => {
                    stops++;
                    stopped = true;
                    return Promise.resolve();
                },
                isWaiting: () => {
                    const camera = current();
                    const delivered = camera?.deliversAt !== undefined && seconds - startedAt >= camera.deliversAt;
                    return !delivered && seconds < (options.waitingUntil ?? Infinity);
                },
                markUnreachable: () => (unreachable = true),
                cancelled: () => false,
                sleep: ms => {
                    seconds += ms / 1000;
                    return Promise.resolve();
                },
                log: silent,
            },
            { attempts: 3, watch: 90, noResponse: 75, endWait: 5 },
        );
        return { starts, stops, unreachable, seconds };
    };

    it('should start once when the camera delivers', async () => {
        const result = await simulate([{ streaming: [false, true], deliversAt: 20 }]);
        expect(result).to.include({ starts: 1, stops: 0, unreachable: false });
        expect(result.seconds).to.equal(20);
    });

    it('should start again when the library gave up a start that sent nothing', async () => {
        // Streaming for 15 seconds, then the library drops it - "no data for 15 seconds".
        const silentStart = { streaming: [false, ...Array<boolean>(15).fill(true), false] };
        const result = await simulate([silentStart, { streaming: [false, true], deliversAt: 10 }]);
        expect(result).to.include({ starts: 2, stops: 0, unreachable: false });
    });

    it('should stop and restart a start the camera never answers', async () => {
        const result = await simulate([{ streaming: [true] }, { streaming: [false, true], deliversAt: 5 }]);
        expect(result).to.include({ starts: 2, stops: 1, unreachable: false });
        expect(result.seconds).to.equal(75 + 5);
    });

    it('should give up after the last attempt and pause the camera', async () => {
        const result = await simulate([{ streaming: [true] }, { streaming: [true] }, { streaming: [true] }]);
        expect(result).to.include({ starts: 3, stops: 3, unreachable: true });
    });

    it('should stop retrying once nobody waits anymore', async () => {
        const result = await simulate([{ streaming: [true] }], { waitingUntil: 30 });
        expect(result).to.include({ starts: 1, stops: 0, unreachable: false });
        expect(result.seconds).to.equal(30);
    });

    it('should wait for a livestream that just ended before starting', async () => {
        const result = await simulate([{ streaming: [false, true], deliversAt: 3 }], { streamingBefore: 2 });
        expect(result).to.include({ starts: 1 });
        expect(result.seconds).to.equal(2 + 3);
    });

    it('should not start while a livestream keeps running, e.g. one of start_stream', async () => {
        const result = await simulate([], { streamingBefore: Infinity });
        expect(result).to.include({ starts: 0, unreachable: false });
    });
});
