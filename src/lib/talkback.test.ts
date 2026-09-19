import { expect } from 'chai';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { Writable } from 'node:stream';

import { AdtsFramer, parseTalkbackSource, pipeToTalkback, talkbackFfmpegArgs, waitForDeviceEvent } from './talkback';

/** Builds an ADTS frame of the given total length, filled with the given byte. */
const frame = (length: number, fill = 0x11): Buffer => {
    const buffer = Buffer.alloc(length, fill);
    buffer[0] = 0xff;
    buffer[1] = 0xf1;
    buffer[2] = 0x60;
    buffer[3] = 0x40 | ((length >> 11) & 0x03);
    buffer[4] = (length >> 3) & 0xff;
    buffer[5] = ((length & 0x07) << 5) | 0x1f;
    buffer[6] = 0xfc;
    return buffer;
};

const collect = async (chunks: Buffer[]): Promise<Buffer[]> => {
    const framer = new AdtsFramer();
    const frames: Buffer[] = [];
    framer.on('data', (data: Buffer) => frames.push(data));
    const ended = new Promise(resolve => framer.on('end', resolve));
    for (const chunk of chunks) {
        framer.write(chunk);
    }
    framer.end();
    await ended;
    return frames;
};

describe('talkback => AdtsFramer', () => {
    it('should split a chunk with several frames', async () => {
        const a = frame(20, 0x01);
        const b = frame(33, 0x02);
        expect(await collect([Buffer.concat([a, b])])).to.deep.equal([a, b]);
    });

    it('should join a frame that arrives in pieces, down to single bytes', async () => {
        const a = frame(40);
        expect(await collect([a.subarray(0, 3), a.subarray(3, 4), a.subarray(4, 39), a.subarray(39)])).to.deep.equal([
            a,
        ]);
        expect(await collect([...a].map(byte => Buffer.from([byte])))).to.deep.equal([a]);
    });

    it('should accept a frame of exactly the header length', async () => {
        const a = frame(7);
        expect(await collect([a])).to.deep.equal([a]);
    });

    it('should skip bytes before the next sync word', async () => {
        const a = frame(20);
        expect(await collect([Buffer.from([0x00, 0xff, 0x12, 0xff]), a])).to.deep.equal([a]);
    });

    it('should skip a sync word that announces a frame shorter than its header', async () => {
        const broken = frame(7);
        broken[4] = 0;
        broken[5] = 0x1f;
        const a = frame(20);
        expect(await collect([broken, a])).to.deep.equal([a]);
    });

    it('should drop an incomplete frame at the end and pass nothing for empty input', async () => {
        const a = frame(20);
        expect(await collect([a, frame(30).subarray(0, 12)])).to.deep.equal([a]);
        expect(await collect([])).to.deep.equal([]);
        expect(await collect([Buffer.from([0xff, 0xf1, 0x60])])).to.deep.equal([]);
    });
});

describe('talkback => parseTalkbackSource', () => {
    it('should accept http(s) URLs and trim them', () => {
        expect(parseTalkbackSource(' https://iobroker:8082/gong.mp3 ')).to.equal('https://iobroker:8082/gong.mp3');
        expect(parseTalkbackSource('HTTP://host/a.wav')).to.equal('HTTP://host/a.wav');
    });

    it('should accept an absolute file path', () => {
        const file = path.resolve('/opt/iobroker/gong.mp3');
        expect(parseTalkbackSource(file)).to.equal(file);
    });

    it('should reject relative paths, other protocols and option like values', () => {
        for (const value of [
            'gong.mp3',
            './gong.mp3',
            '-i',
            '-filter_complex',
            'concat:/a.mp3|/b.mp3',
            'pipe:0',
            'file:/etc/passwd',
            'ftp://host/a.mp3',
            'rtmp://host/live',
            'https://',
            'https://host/a b.mp3',
            '',
            '   ',
        ]) {
            expect(parseTalkbackSource(value), value).to.equal(undefined);
        }
    });

    it('should reject values that are not strings', () => {
        for (const value of [undefined, null, 42, true, {}, ['https://host/a.mp3']]) {
            expect(parseTalkbackSource(value)).to.equal(undefined);
        }
    });
});

describe('talkback => talkbackFfmpegArgs', () => {
    it('should pass the source as the input only and restrict the protocols', () => {
        const args = talkbackFfmpegArgs('/opt/a.mp3');
        expect(args.filter(arg => arg === '/opt/a.mp3').length).to.equal(1);
        expect(args[args.indexOf('-i') + 1]).to.equal('/opt/a.mp3');
        expect(args[args.indexOf('-protocol_whitelist') + 1]).to.equal('file,http,https,tcp,tls');
        expect(args.slice(-3)).to.deep.equal(['-f', 'adts', 'pipe:1']);
        expect(args).to.include('-re');
    });
});

describe('talkback => waitForDeviceEvent', () => {
    const device = (serial: string): { getSerial: () => string } => ({ getSerial: () => serial });

    it('should resolve with the arguments of the event for the device', async () => {
        const emitter = new EventEmitter();
        const waiting = waitForDeviceEvent(emitter, 'station talkback start', 'T8214', 1000);
        emitter.emit('station talkback start', 'station', device('T0000'), 'other');
        emitter.emit('station talkback start', 'station', undefined, 'broken');
        emitter.emit('station talkback start', 'station', device('T8214'), 'stream');
        const args = await waiting;
        expect(args[2]).to.equal('stream');
        expect(emitter.listenerCount('station talkback start')).to.equal(0);
    });

    it('should reject after the timeout and remove its listener', async () => {
        const emitter = new EventEmitter();
        let error: Error | undefined;
        await waitForDeviceEvent(emitter, 'station livestream start', 'T8214', 20).catch((e: Error) => (error = e));
        expect(error?.message).to.contain('station livestream start').and.to.contain('T8214');
        expect(emitter.listenerCount('station livestream start')).to.equal(0);
    });
});

describe('talkback => pipeToTalkback', () => {
    const sink = (): { stream: Writable; frames: Buffer[] } => {
        const frames: Buffer[] = [];
        const stream = new Writable({
            write(chunk: Buffer, _encoding, callback) {
                frames.push(chunk);
                callback();
            },
        });
        return { stream, frames };
    };
    // node stands in for ffmpeg: the script writes to stdout what the encoder would.
    const run = (script: string, stream: Writable, signal = new AbortController().signal): Promise<void> =>
        pipeToTalkback(process.execPath, ['-e', script], stream, signal);

    it('should write the output frame by frame and leave the talkback stream open', async () => {
        const { stream, frames } = sink();
        const bytes = [...Buffer.concat([frame(20, 1), frame(25, 2)])];
        await run(`process.stdout.write(Buffer.from(${JSON.stringify(bytes)}))`, stream);
        await new Promise(resolve => setImmediate(resolve));
        expect(frames).to.deep.equal([frame(20, 1), frame(25, 2)]);
        expect(stream.writableEnded).to.equal(false);
    });

    it('should reject with the end of stderr when the encoder fails', async () => {
        const { stream } = sink();
        let error: Error | undefined;
        await run(`process.stderr.write('No such file or directory'); process.exit(1)`, stream).catch(
            (e: Error) => (error = e),
        );
        expect(error?.message).to.contain('code 1').and.to.contain('No such file or directory');
    });

    it('should stop the encoder and resolve when aborted', async () => {
        const { stream } = sink();
        const controller = new AbortController();
        const running = run('setInterval(() => {}, 1000)', stream, controller.signal);
        controller.abort();
        await running;
    });

    it('should reject when the encoder cannot be started', async () => {
        const { stream } = sink();
        let error: Error | undefined;
        await pipeToTalkback(path.join(__dirname, 'no-such-ffmpeg'), [], stream, new AbortController().signal).catch(
            (e: Error) => (error = e),
        );
        expect(error?.message).to.contain('ENOENT');
    });
});
