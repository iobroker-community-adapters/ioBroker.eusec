import { expect } from 'chai';
import http from 'node:http';
import stream from 'node:stream';

import {
    DEFAULT_OPTIONS,
    DEFAULT_START_ATTEMPT_OPTIONS,
    OnDemandStreams,
    busyReason,
    unreachableReason,
    findAdtsStart,
    findKeyframeStart,
    onDemandSource,
    parseOnDemandPath,
    startUntilDelivered,
} from './ondemand';
import type { OnDemandHooks, OnDemandOptions } from './ondemand';

const silent = { debug: (): void => {}, info: (): void => {}, warn: (): void => {} };
const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Waits, in real time, for what travels over the loopback interface - a request that reaches the
 * server, an answer, a closed connection. Gives up after ten seconds and leaves the report to the
 * expect that follows.
 */
const eventually = async (condition: () => boolean): Promise<void> => {
    const deadline = Date.now() + 10000;
    while (!condition() && Date.now() < deadline) {
        await wait(5);
    }
};

/** Lets the promise chains a timer callback started run. */
const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

/**
 * The timers and the time of OnDemandStreams, which only move on when a test says so. A busy
 * machine can delay what travels over the network, but it never lets a timeout pass by itself.
 */
class Clock {
    private time = 0;
    private readonly timers = new Set<{ at: number; callback: () => void }>();
    public readonly hooks: Pick<OnDemandHooks, 'setTimeout' | 'clearTimeout' | 'now'> = {
        setTimeout: (callback, ms) => {
            const timer = { at: this.time + ms, callback };
            this.timers.add(timer);
            return timer;
        },
        clearTimeout: timer => void this.timers.delete(timer as { at: number; callback: () => void }),
        now: () => this.time,
    };

    /**
     * Moves the time on and fires the timers that fall due, in order, each after the previous one
     * settled - also the ones those set.
     *
     * @param ms How far
     */
    public async advance(ms: number): Promise<void> {
        const end = this.time + ms;
        for (;;) {
            const next = [...this.timers].filter(timer => timer.at <= end).sort((a, b) => a.at - b.at)[0];
            if (!next) {
                break;
            }
            this.timers.delete(next);
            this.time = next.at;
            next.callback();
            await flush();
        }
        this.time = end;
        await flush();
    }
}

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

describe('ondemand => OnDemandStreams', function () {
    // eventually() may take long on a busy machine, the timers of the streams never do.
    this.timeout(30000);

    let streams: OnDemandStreams;
    let clock: Clock;
    let started: string[];
    let stopped: string[];
    /** The requests that reached the server and were not refused, as "serial track". */
    let requested: string[];
    let logged: { debug: string[]; info: string[]; warn: string[] };
    /** Devices whose start hook still runs - a request that comes meanwhile joins it. */
    let running: Set<string>;

    /** A start hook like untilDelivered() that also maintains running. */
    let deliver: (serial: string) => Promise<void>;

    const create = async (
        options: Partial<OnDemandOptions> = {},
        hooks: Partial<OnDemandHooks> = {},
    ): Promise<void> => {
        clock = new Clock();
        started = [];
        stopped = [];
        requested = [];
        logged = { debug: [], info: [], warn: [] };
        // Bound to this test: a start hook of the previous one may still run, and would otherwise
        // ask the streams of this test and take its device out of running.
        const active = new Set<string>();
        running = active;
        let own!: OnDemandStreams;
        deliver = serial => {
            active.add(serial);
            return untilDelivered(() => own)(serial).finally(() => void active.delete(serial));
        };
        streams = own = new OnDemandStreams(
            {
                start: serial => {
                    started.push(serial);
                    return deliver(serial);
                },
                stop: serial => Promise.resolve(void stopped.push(serial)),
                log: {
                    debug: message => {
                        logged.debug.push(message);
                        const request = /^On-demand stream (\S+): go2rtc requests the (video|audio)/.exec(message);
                        if (request) {
                            requested.push(`${request[1]} ${request[2]}`);
                        }
                    },
                    info: message => void logged.info.push(message),
                    warn: message => void logged.warn.push(message),
                },
                ...clock.hooks,
                ...hooks,
            },
            { idleStopDelay: 300, stopSettle: 0, firstDataTimeout: 1500, audioTimeout: 100, ...options },
        );
        await streams.listen();
    };

    /** Waits until the server saw every request of the device closed. */
    const closed = (serial: string): Promise<void> => eventually(() => !streams.isWatched(serial));

    afterEach(async () => {
        await streams.close();
    });

    it('should start the livestream on the first request and deliver what the camera sends', async () => {
        await create();
        const [videoUrl, audioUrl] = streams.sources('CAM1');
        const video = pull(videoUrl);
        const audio = pull(audioUrl);
        await eventually(() => requested.length === 2);
        expect(started).to.deep.equal(['CAM1']);

        const cameraVideo = new stream.PassThrough();
        const cameraAudio = new stream.PassThrough();
        streams.attach('CAM1', cameraVideo, cameraAudio);
        cameraVideo.write(keyframe('frame'));
        cameraAudio.write(adts('sound'));

        expect((await video.response).statusCode).to.equal(200);
        expect((await audio.response).statusCode).to.equal(200);
        await eventually(() => video.data().includes('frame') && audio.data().includes('sound'));
        expect(video.data()).to.contain('frame');
        expect(audio.data()).to.contain('sound');
    });

    it('should send the header only once data is there, even when the camera takes long', async () => {
        await create();
        const video = pull(streams.sources('CAM1')[0]);
        let answered = false;
        void video.response.then(() => (answered = true));
        await eventually(() => requested.length === 1);
        await clock.advance(1499);
        await wait(50);
        expect(answered).to.equal(false);

        const cameraVideo = new stream.PassThrough();
        streams.attach('CAM1', cameraVideo, new stream.PassThrough());
        cameraVideo.write(keyframe('late'));
        expect((await video.response).statusCode).to.equal(200);
    });

    it('should stop the livestream once nobody watched it for the grace period', async () => {
        await create();
        const video = pull(streams.sources('CAM1')[0]);
        await eventually(() => requested.length === 1);
        const cameraVideo = new stream.PassThrough();
        streams.attach('CAM1', cameraVideo, new stream.PassThrough());
        cameraVideo.write(keyframe('frame'));
        await video.response;

        video.request.destroy();
        await closed('CAM1');
        await clock.advance(299);
        expect(stopped).to.deep.equal([]);
        await clock.advance(1);
        expect(stopped).to.deep.equal(['CAM1']);
    });

    it('should keep the livestream when go2rtc comes back within the grace period', async () => {
        await create({ idleStopDelay: 400 });
        const first = pull(streams.sources('CAM1')[0]);
        await eventually(() => requested.length === 1);
        const cameraVideo = new stream.PassThrough();
        streams.attach('CAM1', cameraVideo, new stream.PassThrough());
        cameraVideo.write(keyframe('frame'));
        await first.response;
        first.request.destroy();
        await closed('CAM1');
        await clock.advance(399);

        const second = pull(streams.sources('CAM1')[0]);
        await eventually(() => requested.length === 2);
        cameraVideo.write(keyframe('more'));
        expect((await second.response).statusCode).to.equal(200);
        await clock.advance(1000);
        expect(stopped).to.deep.equal([]);
        expect(started).to.deep.equal(['CAM1']);
        second.request.destroy();
    });

    it('should not stop a livestream that nobody requested, e.g. one started for talkback', async () => {
        await create();
        const cameraVideo = new stream.PassThrough();
        streams.attach('CAM1', cameraVideo, new stream.PassThrough());
        cameraVideo.write(keyframe('frame'));
        await clock.advance(1000);
        expect(stopped).to.deep.equal([]);
        expect(cameraVideo.readableFlowing).to.equal(true);
    });

    it('should end the requests when the livestream stops, so go2rtc reconnects', async () => {
        await create();
        const video = pull(streams.sources('CAM1')[0]);
        await eventually(() => requested.length === 1);
        const cameraVideo = new stream.PassThrough();
        streams.attach('CAM1', cameraVideo, new stream.PassThrough());
        cameraVideo.write(keyframe('frame'));
        const response = await video.response;
        // A start hook that still runs takes the next request over instead of a new start.
        await eventually(() => !running.has('CAM1'));
        const ended = new Promise(resolve => response.on('end', resolve));
        streams.detach('CAM1');
        await ended;

        pull(streams.sources('CAM1')[0]);
        await eventually(() => started.length === 2);
        expect(started).to.deep.equal(['CAM1', 'CAM1']);
    });

    it('should start again for a request that joined a livestream which stopped before it delivered', async () => {
        await create({ idleStopDelay: 100 });
        const first = pull(streams.sources('CAM1')[0]);
        await eventually(() => requested.length === 1);
        const cameraVideo = new stream.PassThrough();
        streams.attach('CAM1', cameraVideo, new stream.PassThrough());
        cameraVideo.write(keyframe('frame'));
        await first.response;
        await eventually(() => !running.has('CAM1'));
        first.request.destroy();
        await closed('CAM1');
        await clock.advance(100);
        // The stop is asked for, the camera still streams until the library reports the end.
        expect(stopped).to.deep.equal(['CAM1']);

        const second = pull(streams.sources('CAM1')[0]);
        await eventually(() => requested.length === 2);
        streams.detach('CAM1');
        expect(started).to.deep.equal(['CAM1', 'CAM1']);
        const nextVideo = new stream.PassThrough();
        streams.attach('CAM1', nextVideo, new stream.PassThrough());
        nextVideo.write(keyframe('next'));
        expect((await second.response).statusCode).to.equal(200);
        second.request.destroy();
    });

    it('should not start a second time when a livestream stops while its start still runs', async () => {
        // The retries of startUntilDelivered() stop a livestream the camera never answered, and
        // a station that drops reports the stop of each of its devices - both while the start runs.
        await create();
        const waiting = pull(streams.sources('CAM1')[0]);
        await eventually(() => requested.length === 1);
        expect(started).to.deep.equal(['CAM1']);
        streams.detach('CAM1');
        streams.detach('CAM1');
        expect(started).to.deep.equal(['CAM1']);

        const cameraVideo = new stream.PassThrough();
        streams.attach('CAM1', cameraVideo, new stream.PassThrough());
        cameraVideo.write(keyframe('frame'));
        expect((await waiting.response).statusCode).to.equal(200);
        waiting.request.destroy();
    });

    it('should not start again when a livestream stops that nobody waits for', async () => {
        await create();
        const cameraVideo = new stream.PassThrough();
        streams.attach('CAM1', cameraVideo, new stream.PassThrough());
        streams.detach('CAM1');
        streams.detach('UNKNOWN');
        expect(started).to.deep.equal([]);
    });

    it('should give up on audio of a mute camera, so the video is not held back', async () => {
        await create();
        const [videoUrl, audioUrl] = streams.sources('CAM1');
        const audio = pull(audioUrl);
        await eventually(() => requested.length === 1);
        const cameraVideo = new stream.PassThrough();
        streams.attach('CAM1', cameraVideo, new stream.PassThrough());
        cameraVideo.write(keyframe('frame'));
        await eventually(() => logged.info.some(message => message.includes('first picture')));
        await clock.advance(99);
        expect(logged.info.some(message => message.includes('no audio'))).to.equal(false);
        await clock.advance(1);
        expect((await audio.response).statusCode).to.equal(404);

        // Every further consumer learns it right away instead of waiting again.
        const again = pull(audioUrl);
        expect((await again.response).statusCode).to.equal(404);
        pull(videoUrl).request.destroy();
    });

    it('should answer 504 when the camera never delivers, and try again on the next request', async () => {
        await create({ firstDataTimeout: 100 });
        const video = pull(streams.sources('CAM1')[0]);
        await eventually(() => requested.length === 1);
        await clock.advance(100);
        expect((await video.response).statusCode).to.equal(504);
        await eventually(() => !running.has('CAM1'));
        pull(streams.sources('CAM1')[0]);
        await eventually(() => started.length === 2);
        expect(started).to.deep.equal(['CAM1', 'CAM1']);
    });

    it('should schedule and clear its timers through the hooks', async () => {
        const scheduled: number[] = [];
        let cleared = 0;
        await create(
            { firstDataTimeout: 100 },
            {
                start: () => new Promise<void>(() => {}),
                setTimeout: (callback, ms) => {
                    scheduled.push(ms);
                    return setTimeout(callback, ms);
                },
                clearTimeout: timer => {
                    cleared++;
                    clearTimeout(timer as NodeJS.Timeout);
                },
            },
        );
        expect((await pull(streams.sources('CAM1')[0]).response).statusCode).to.equal(504);
        expect(scheduled).to.deep.equal([100]);
        expect(cleared).to.be.greaterThan(0);
    });

    it('should not start a second time while a start still runs, also after a 504', async () => {
        let finish!: () => void;
        const starts: string[] = [];
        await create(
            { firstDataTimeout: 100 },
            {
                // A start whose retries take longer than firstDataTimeout.
                start: serial => {
                    starts.push(serial);
                    return new Promise<void>(resolve => (finish = resolve));
                },
            },
        );
        const first = pull(streams.sources('CAM1')[0]);
        await eventually(() => requested.length === 1);
        await clock.advance(100);
        expect((await first.response).statusCode).to.equal(504);
        const again = pull(streams.sources('CAM1')[0]);
        await eventually(() => requested.length === 2);
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
        await closed('CAM1');
        pull(streams.sources('CAM1')[0]);
        await eventually(() => starts.length === 2);
        expect(starts).to.deep.equal(['CAM1', 'CAM1']);
        finish();
    });

    it('should drop data for a reader that does not keep up, and go on at the next keyframe', async () => {
        await create();
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
        await eventually(() => requested.length === 1);
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
        await eventually(() => logged.debug.some(message => message.includes('dropping data')));
        expect(logged.debug.some(message => message.includes('dropping data'))).to.equal(true);

        response.on('data', (data: Buffer) => {
            first ??= data;
            received += data.length;
        });
        response.resume();
        await eventually(() => received > 0);
        cameraVideo.write(Buffer.concat([Buffer.from('tail'), keyframe('next')]));
        expect(received).to.be.greaterThan(0);
        expect(received).to.be.lessThan(1025 * chunk.length);
        expect([...first!.subarray(0, 5)]).to.deep.equal([0, 0, 0, 1, 0x67]);
        response.destroy();
    });

    it('should pass keyframes of 16 KB and more to a reader that keeps up, and drop beyond maxBuffered', async () => {
        await create({ maxBuffered: 100 * 1024 });
        let received = 0;
        http.get(streams.sources('CAM1')[0], res => res.on('data', (data: Buffer) => (received += data.length)));
        await eventually(() => requested.length === 1);
        const cameraVideo = new stream.PassThrough();
        streams.attach('CAM1', cameraVideo, new stream.PassThrough());
        // A camera keyframe is far larger than the 16 KB at which write() starts returning false.
        const frames = [
            keyframe('x'.repeat(16 * 1024 - 5)),
            Buffer.from([0, 0, 0, 1, 0x41, 1]),
            keyframe('y'.repeat(64 * 1024)),
            Buffer.from([0, 0, 0, 1, 0x41, 2]),
            // Just below maxBuffered, with room for the framing of the chunked response.
            keyframe('z'.repeat(100 * 1024 - 64)),
            Buffer.from([0, 0, 0, 1, 0x41, 3]),
        ];
        let sent = 0;
        for (const frame of frames) {
            cameraVideo.write(frame);
            sent += frame.length;
            // A reader that keeps up has read each frame before the camera sends the next.
            await eventually(() => received === sent);
        }
        expect(logged.debug.some(message => message.includes('dropping data'))).to.equal(false);
        expect(received).to.equal(sent);

        // One chunk above maxBuffered is a backlog, however fast the reader is.
        cameraVideo.write(keyframe('w'.repeat(100 * 1024)));
        cameraVideo.write(Buffer.from([0, 0, 0, 1, 0x41, 4]));
        await eventually(() => received === sent + 5 + 100 * 1024);
        expect(logged.debug.some(message => message.includes('dropping data'))).to.equal(true);
        expect(received).to.equal(sent + 5 + 100 * 1024);
    });

    it('should report a waiting request until the livestream arrives', async () => {
        await create();
        expect(streams.isWaiting('CAM1')).to.equal(false);
        const video = pull(streams.sources('CAM1')[0]);
        await eventually(() => requested.length === 1);
        expect(streams.isWaiting('CAM1')).to.equal(true);

        const cameraVideo = new stream.PassThrough();
        streams.attach('CAM1', cameraVideo, new stream.PassThrough());
        expect(streams.isWaiting('CAM1')).to.equal(false);
        video.request.destroy();
    });

    it('should not start a second device of a station while the first one is watched', async () => {
        await create({}, { group: () => 'STATION' });
        const first = pull(streams.sources('CAM1')[0]);
        await eventually(() => requested.length === 1);
        const second = pull(streams.sources('CAM2')[0]);
        expect((await second.response).statusCode).to.equal(503);
        expect(started).to.deep.equal(['CAM1']);
        first.request.destroy();
    });

    it('should log a refusal once, not for every attempt of go2rtc', async () => {
        await create({}, { group: () => 'STATION' });
        const first = pull(streams.sources('CAM1')[0]);
        await eventually(() => requested.length === 1);
        for (const url of [...streams.sources('CAM2'), ...streams.sources('CAM2')]) {
            await pull(url).response;
        }
        expect(logged.info.filter(message => message.includes('busy'))).to.have.length(1);
        first.request.destroy();
    });

    it('should name the watched device in the answer go2rtc hands on to the player', async () => {
        await create({}, { group: () => 'STATION', name: serial => (serial === 'CAM1' ? 'Garten Pool' : 'Haustür') });
        const first = pull(streams.sources('CAM1')[0]);
        await eventually(() => requested.length === 1);
        const second = await pull(streams.sources('CAM2')[0]).response;
        expect(second.statusCode).to.equal(503);
        expect(second.statusMessage).to.equal('Station busy - Garten Pool is streaming');
        first.request.destroy();
    });

    it('should keep the busy reason within what HTTP allows', () => {
        expect(busyReason('Haustür Weg')).to.equal('Station busy - Haustuer Weg is streaming');
        expect(busyReason('Kamera 📷')).to.equal('Station busy - Kamera is streaming');
        expect(busyReason('')).to.equal('Station busy - another device is streaming');
        expect(unreachableReason('Türklingel')).to.equal('Camera not reachable - Tuerklingel');
    });

    it('should hand the station over quickly when another device waits for it', async () => {
        await create({ idleStopDelay: 2000, handoverDelay: 50 }, { group: () => 'STATION' });
        const first = pull(streams.sources('CAM1')[0]);
        await eventually(() => requested.length === 1);
        expect((await pull(streams.sources('CAM2')[0]).response).statusCode).to.equal(503);
        first.request.destroy();
        await closed('CAM1');
        await clock.advance(49);
        expect(stopped).to.deep.equal([]);
        await clock.advance(1);
        expect(stopped).to.deep.equal(['CAM1']);
    });

    it('should not let a start that never delivers keep the station for good', async () => {
        await create({ startBlock: 100 }, { group: () => 'STATION' });
        const first = pull(streams.sources('CAM1')[0]);
        await eventually(() => requested.length === 1);
        expect(streams.stationBusyWith('CAM2')).to.equal('CAM1');
        await clock.advance(99);
        expect(streams.stationBusyWith('CAM2')).to.equal('CAM1');
        await clock.advance(1);
        expect(streams.stationBusyWith('CAM2')).to.equal(undefined);
        first.request.destroy();
    });

    it('should answer right away for a camera whose start attempts failed, and free its station', async () => {
        await create({ unreachableFor: 200 }, { group: () => 'STATION' });
        const waiting = pull(streams.sources('CAM1')[0]);
        await eventually(() => requested.length === 1);
        streams.markUnreachable('CAM1');
        const answer = await waiting.response;
        expect(answer.statusCode).to.equal(503);
        expect(answer.statusMessage).to.equal('Camera not reachable - CAM1');
        expect(streams.stationBusyWith('CAM2')).to.equal(undefined);

        expect((await pull(streams.sources('CAM1')[0]).response).statusCode).to.equal(503);
        await clock.advance(199);
        expect((await pull(streams.sources('CAM1')[0]).response).statusCode).to.equal(503);
        expect(started).to.deep.equal(['CAM1']);
        await clock.advance(1);
        await eventually(() => !running.has('CAM1'));
        pull(streams.sources('CAM1')[0]);
        await eventually(() => started.length === 2);
        expect(started).to.deep.equal(['CAM1', 'CAM1']);
    });

    it('should tell start_stream which watched device keeps the station busy', async () => {
        await create({}, { group: serial => (serial === 'CAM3' ? 'OTHER' : 'STATION') });
        expect(streams.stationBusyWith('CAM2')).to.equal(undefined);
        const first = pull(streams.sources('CAM1')[0]);
        await eventually(() => requested.length === 1);
        expect(streams.stationBusyWith('CAM2')).to.equal('CAM1');
        expect(streams.stationBusyWith('CAM1')).to.equal(undefined);
        expect(streams.stationBusyWith('CAM3')).to.equal(undefined);
        first.request.destroy();
    });

    it('should start devices of different stations side by side', async () => {
        await create({}, { group: serial => (serial === 'CAM1' ? 'A' : 'B') });
        const first = pull(streams.sources('CAM1')[0]);
        const second = pull(streams.sources('CAM2')[0]);
        await eventually(() => started.length === 2);
        expect(started).to.have.members(['CAM1', 'CAM2']);
        first.request.destroy();
        second.request.destroy();
    });

    it('should let the next device of the station start once nobody watches the first one', async () => {
        await create({}, { group: () => 'STATION' });
        const first = pull(streams.sources('CAM1')[0]);
        await eventually(() => requested.length === 1);
        first.request.destroy();
        await closed('CAM1');
        pull(streams.sources('CAM2')[0]);
        await eventually(() => started.length === 2);
        expect(started).to.deep.equal(['CAM1', 'CAM2']);
    });

    it('should stop the idle livestream of another device of the station before starting', async () => {
        const order: string[] = [];
        let finishStop!: () => void;
        await create(
            {},
            {
                // Like startLivestream() of the adapter.
                start: async serial => {
                    await streams.handOver(serial);
                    order.push(`start ${serial}`);
                    return deliver(serial);
                },
                stop: serial => {
                    order.push(`stop ${serial}`);
                    return new Promise<void>(resolve => (finishStop = resolve));
                },
                group: serial => (serial === 'CAM3' ? 'OTHER' : 'STATION'),
            },
        );
        const first = pull(streams.sources('CAM1')[0]);
        await eventually(() => order.length === 1);
        streams.attach('CAM1', new stream.PassThrough(), new stream.PassThrough());
        await eventually(() => !running.has('CAM1'));
        first.request.destroy();
        await closed('CAM1');

        // A device of another station leaves the idle livestream alone.
        const other = pull(streams.sources('CAM3')[0]);
        await eventually(() => order.length === 2);
        expect(order).to.deep.equal(['start CAM1', 'start CAM3']);

        const second = pull(streams.sources('CAM2')[0]);
        await eventually(() => order.length === 3);
        expect(order).to.deep.equal(['start CAM1', 'start CAM3', 'stop CAM1']);
        finishStop();
        await eventually(() => order.length === 4);
        expect(order).to.deep.equal(['start CAM1', 'start CAM3', 'stop CAM1', 'start CAM2']);

        // The idle stop of the first device does not come a second time.
        streams.detach('CAM1');
        await clock.advance(1000);
        expect(order).to.deep.equal(['start CAM1', 'start CAM3', 'stop CAM1', 'start CAM2']);
        other.request.destroy();
        second.request.destroy();
    });

    it('should start only once the data of a stopped livestream of the station is through', async () => {
        const order: string[] = [];
        const waited = (serial: string): number =>
            logged.debug.filter(message => message.startsWith(`On-demand stream ${serial}: waiting`)).length;
        await create(
            { idleStopDelay: 100, stopSettle: 600 },
            {
                // Like startLivestream() of the adapter.
                start: async serial => {
                    await streams.handOver(serial);
                    order.push(`start ${serial}`);
                    return deliver(serial);
                },
                stop: serial => Promise.resolve(void order.push(`stop ${serial}`)),
                group: serial => (serial === 'CAM3' ? 'OTHER' : 'STATION'),
            },
        );
        const requests: Pull[] = [];
        try {
            // Hand-over: the start waits stopSettle after the stop it sent.
            requests.push(pull(streams.sources('CAM1')[0]));
            await eventually(() => order.length === 1);
            streams.attach('CAM1', new stream.PassThrough(), new stream.PassThrough());
            // A start hook that still runs counts as starting, and its device would be stopped again.
            await eventually(() => !running.has('CAM1'));
            requests[0].request.destroy();
            await closed('CAM1');
            requests.push(pull(streams.sources('CAM2')[0]));
            await eventually(() => waited('CAM2') === 1);
            expect(order).to.deep.equal(['start CAM1', 'stop CAM1']);
            streams.detach('CAM1');
            await clock.advance(599);
            expect(order).to.deep.equal(['start CAM1', 'stop CAM1']);
            // Another station is not held up by it.
            requests.push(pull(streams.sources('CAM3')[0]));
            await eventually(() => order.length === 3);
            expect(order).to.deep.equal(['start CAM1', 'stop CAM1', 'start CAM3']);
            await clock.advance(1);
            await eventually(() => order.length === 4);
            expect(order).to.deep.equal(['start CAM1', 'stop CAM1', 'start CAM3', 'start CAM2']);

            // Idle stop: nothing left to hand over, the start still waits for the rest of the stop.
            streams.attach('CAM2', new stream.PassThrough(), new stream.PassThrough());
            await eventually(() => !running.has('CAM2'));
            requests[1].request.destroy();
            await closed('CAM2');
            await clock.advance(100);
            expect(order.slice(4)).to.deep.equal(['stop CAM2']);
            streams.detach('CAM2');
            requests.push(pull(streams.sources('CAM1')[0]));
            await eventually(() => waited('CAM1') === 1);
            await clock.advance(599);
            expect(order.slice(4)).to.deep.equal(['stop CAM2']);
            await clock.advance(1);
            await eventually(() => order.length === 6);
            expect(order.slice(4)).to.deep.equal(['stop CAM2', 'start CAM1']);

            // Once the stop is stopSettle ago, the start goes out right away.
            streams.attach('CAM1', new stream.PassThrough(), new stream.PassThrough());
            await eventually(() => !running.has('CAM1'));
            requests[3].request.destroy();
            await closed('CAM1');
            await clock.advance(100);
            expect(order.slice(6)).to.deep.equal(['stop CAM1']);
            streams.detach('CAM1');
            await clock.advance(600);
            requests.push(pull(streams.sources('CAM2')[0]));
            await eventually(() => order.length === 8);
            expect(order.slice(6)).to.deep.equal(['stop CAM1', 'start CAM2']);
            expect(waited('CAM2')).to.equal(1);
        } finally {
            requests.forEach(request => request.request.destroy());
        }
    });

    it('should stop a livestream of the station nobody watches, also one started through start_stream', async () => {
        await create({}, { group: serial => (serial === 'CAM3' ? 'OTHER' : 'STATION') });
        // start_stream: the livestream arrives without any request of go2rtc.
        streams.attach('CAM1', new stream.PassThrough(), new stream.PassThrough());
        streams.attach('CAM3', new stream.PassThrough(), new stream.PassThrough());
        // Watched - stationBusyWith() refuses the start before it comes to a hand-over.
        const watched = pull(streams.sources('CAM4')[0]);
        await eventually(() => requested.length === 1);
        streams.attach('CAM4', new stream.PassThrough(), new stream.PassThrough());
        await streams.handOver('CAM2');
        expect(stopped).to.deep.equal(['CAM1']);
        // Once the library reported the stop, the next start attempt finds nothing to hand over.
        streams.detach('CAM1');
        await streams.handOver('CAM2');
        expect(stopped).to.deep.equal(['CAM1']);
        watched.request.destroy();
    });

    it('should keep the station busy while the adapter uses a livestream of it', async () => {
        let talking = true;
        await create({}, { group: () => 'STATION', inUse: serial => serial === 'CAM1' && talking });
        streams.attach('CAM1', new stream.PassThrough(), new stream.PassThrough());
        expect(streams.stationBusyWith('CAM2')).to.equal('CAM1');
        const refused = await pull(streams.sources('CAM2')[0]).response;
        expect(refused.statusCode).to.equal(503);
        expect(refused.statusMessage).to.equal('Station busy - CAM1 is streaming');
        await streams.handOver('CAM2');
        expect(stopped).to.deep.equal([]);

        // The talkback ended.
        talking = false;
        expect(streams.stationBusyWith('CAM2')).to.equal(undefined);
        await streams.handOver('CAM2');
        expect(stopped).to.deep.equal(['CAM1']);
    });

    it('should hand over even when stopping the livestream of the station fails', async () => {
        await create({}, { stop: () => Promise.reject(new Error('station not connected')), group: () => 'STATION' });
        streams.attach('CAM1', new stream.PassThrough(), new stream.PassThrough());
        await streams.handOver('CAM2');
        expect(logged.warn).to.deep.equal([
            'On-demand stream CAM1: livestream could not be stopped: Error: station not connected',
        ]);
    });

    it('should refuse a request that joined a livestream the station hands over', async () => {
        await create({}, { group: () => 'STATION' });
        const first = pull(streams.sources('CAM1')[0]);
        await eventually(() => requested.length === 1);
        streams.attach('CAM1', new stream.PassThrough(), new stream.PassThrough());
        // A start hook that still runs would start CAM1 again instead of refusing it.
        await eventually(() => !running.has('CAM1'));
        first.request.destroy();
        await closed('CAM1');
        const second = pull(streams.sources('CAM2')[0]);
        await eventually(() => requested.length === 2);
        // Comes after the stop of CAM1 was sent, before the library reported it.
        const back = pull(streams.sources('CAM1')[0]);
        await eventually(() => requested.length === 3);
        streams.detach('CAM1');
        const answer = await back.response;
        expect(answer.statusCode).to.equal(503);
        expect(answer.statusMessage).to.equal('Station busy - CAM2 is streaming');
        expect(started).to.deep.equal(['CAM1', 'CAM2']);
        second.request.destroy();
    });

    it('should stop a start that never delivered once nobody waits for it anymore', async () => {
        await create();
        const video = pull(streams.sources('CAM1')[0]);
        await eventually(() => requested.length === 1);
        expect(started).to.deep.equal(['CAM1']);
        video.request.destroy();
        await closed('CAM1');
        await clock.advance(299);
        expect(stopped).to.deep.equal([]);
        await clock.advance(1);
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
            { start: untilDelivered(() => streams), stop: () => Promise.resolve(), log: silent, ...new Clock().hooks },
            { idleStopDelay: 300, stopSettle: 0, firstDataTimeout: 1500, audioTimeout: 100 },
        );
        await streams.listen();
        try {
            const cameraVideo = new stream.PassThrough();
            // Listens after the streams, so it sees a chunk once they handled it.
            const filter = new stream.PassThrough();
            streams.attach('CAM1', cameraVideo, new stream.PassThrough(), filter);
            let handled = 0;
            filter.on('data', () => handled++);
            cameraVideo.write(keyframe('before'));
            await eventually(() => handled === 1);

            const video = pull(streams.sources('CAM1')[0]);
            await eventually(() => streams.isWatched('CAM1'));
            // The middle of a frame, as the camera sends it - go2rtc would refuse it.
            cameraVideo.write(Buffer.from([0x03, 0xdb, 0x03, 0x84, 0x55]));
            cameraVideo.write(Buffer.concat([Buffer.from('tail'), keyframe('next')]));
            const response = await video.response;
            await eventually(() => video.data().includes('next'));

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
        options: {
            waitingUntil?: number;
            streamingBefore?: number;
            /** The second go2rtc gets its 504 and asks again - for that check nobody waits. */
            requestEndsAt?: number;
            startOptions?: typeof DEFAULT_START_ATTEMPT_OPTIONS;
        } = {},
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
                    return (
                        !delivered && seconds < (options.waitingUntil ?? Infinity) && seconds !== options.requestEndsAt
                    );
                },
                markUnreachable: () => (unreachable = true),
                cancelled: () => false,
                sleep: ms => {
                    seconds += ms / 1000;
                    return Promise.resolve();
                },
                log: silent,
            },
            options.startOptions ?? { attempts: 3, watch: 90, noResponse: 75, endWait: 5 },
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

    it('should not end the attempts at the 504 go2rtc gets while a start still runs', async () => {
        const { attempts, endWait, watch } = DEFAULT_START_ATTEMPT_OPTIONS;
        const window = attempts * (endWait + watch);
        // The longest the attempts can take - a request must not end before.
        expect(DEFAULT_OPTIONS.firstDataTimeout / 1000).to.be.greaterThan(window);
        const neverAnswers = [{ streaming: [true] }, { streaming: [true] }, { streaming: [true] }];
        const result = await simulate(neverAnswers, {
            requestEndsAt: DEFAULT_OPTIONS.firstDataTimeout / 1000,
            startOptions: DEFAULT_START_ATTEMPT_OPTIONS,
        });
        expect(result).to.include({ starts: 3, stops: 3, unreachable: true });
        // A 504 within the attempts - the old 180 seconds - ended them as if the livestream arrived.
        const early = await simulate(neverAnswers, { requestEndsAt: 180, startOptions: DEFAULT_START_ATTEMPT_OPTIONS });
        expect(early).to.include({ starts: 3, stops: 2, unreachable: false });
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
