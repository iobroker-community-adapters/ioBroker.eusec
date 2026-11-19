import { expect } from 'chai';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';
import { AudioCodec, type StreamMetadata, VideoCodec } from 'eufy-security-client';

import type { ioBrokerLogger } from './log';
import { createVideoFilter, streamToGo2rtc } from './video';

/** Stand-in for go2rtc's ReadHeaderTimeout of 5 seconds, scaled down to keep the tests fast. */
const HEADER_TIMEOUT = 300;

interface Ingest {
    dst: string | null;
    bytes: number;
}

/**
 * Starts a server that, like go2rtc, drops every connection whose request header did not arrive
 * within HEADER_TIMEOUT, reads the body of a stream POST until it ends and then answers.
 */
const startIngestServer = async (): Promise<{ port: number; ingests: Ingest[]; close: () => Promise<void> }> => {
    const ingests: Ingest[] = [];
    const server = http.createServer(
        { headersTimeout: HEADER_TIMEOUT, requestTimeout: 0, connectionsCheckingInterval: 20 },
        (request, response) => {
            const ingest: Ingest = {
                dst: new URL(request.url ?? '', 'http://localhost').searchParams.get('dst'),
                bytes: 0,
            };
            ingests.push(ingest);
            request.on('data', (chunk: Buffer) => (ingest.bytes += chunk.length));
            request.on('end', () => response.end());
        },
    );
    await new Promise<void>(resolve => server.listen(0, 'localhost', resolve));
    return {
        port: (server.address() as AddressInfo).port,
        ingests,
        close: () =>
            new Promise<void>(resolve => {
                server.closeAllConnections();
                server.close(() => resolve());
            }),
    };
};

const createLog = (): { log: ioBrokerLogger; errors: string[] } => {
    const errors: string[] = [];
    const log = {
        error: (message: string) => errors.push(message),
        warn: () => {},
        info: () => {},
        debug: () => {},
    } as unknown as ioBrokerLogger;
    return { log, errors };
};

// H.265 is handed to go2rtc untouched, so the test data does not have to be a valid H.264 stream.
const metadata = {
    videoCodec: VideoCodec.H265,
    videoFPS: 15,
    videoWidth: 1920,
    videoHeight: 1080,
    audioCodec: AudioCodec.AAC,
} as StreamMetadata;

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

describe('video => streamToGo2rtc', () => {
    let server: Awaited<ReturnType<typeof startIngestServer>>;

    beforeEach(async () => {
        server = await startIngestServer();
    });

    afterEach(async () => {
        await server.close();
    });

    const run = (
        video: PassThrough,
        audio: PassThrough,
        log: ioBrokerLogger,
    ): Promise<Array<PromiseSettledResult<void>>> =>
        streamToGo2rtc(
            'T8134520241455AC',
            video,
            audio,
            log,
            { go2rtc_api_port: server.port } as ioBroker.AdapterConfig,
            'eusec.0',
            metadata,
        );

    it('should keep the ingest open when the first data arrives after the header timeout', async () => {
        const video = new PassThrough();
        const audio = new PassThrough();
        const { log, errors } = createLog();
        const results = run(video, audio, log);

        await delay(HEADER_TIMEOUT * 3);
        video.end(Buffer.alloc(1000, 1));
        audio.end(Buffer.alloc(100, 2));

        expect((await results).map(result => result.status)).to.deep.equal(['fulfilled', 'fulfilled']);
        expect(errors).to.deep.equal([]);
        expect(server.ingests.map(ingest => ingest.bytes).sort((a, b) => a - b)).to.deep.equal([100, 1000]);
        expect(server.ingests.every(ingest => ingest.dst === 'T8134520241455AC')).to.equal(true);
    });

    it('should keep the ingest open when the stream ends without any data', async () => {
        const video = new PassThrough();
        const audio = new PassThrough();
        const { log, errors } = createLog();
        const results = run(video, audio, log);

        await delay(HEADER_TIMEOUT * 3);
        // Both requests reached the server although not a single byte of the body was sent.
        expect(server.ingests).to.have.length(2);
        video.end();
        audio.end();

        expect((await results).map(result => result.status)).to.deep.equal(['fulfilled', 'fulfilled']);
        expect(errors).to.deep.equal([]);
        expect(server.ingests.map(ingest => ingest.bytes)).to.deep.equal([0, 0]);
    });
});

describe('video => createVideoFilter', () => {
    /** Real SPS of a Wall Light Cam S100 - 1600x1200, declared level 4.2. */
    const sps = Buffer.from(
        '000000012764002aad00ce8064025e9a808080f8000003000800000300f18000038f700005572efffe0500',
        'hex',
    );
    const idr = Buffer.from('0000000165880101', 'hex');
    const p = Buffer.from('00000001419a0202', 'hex');
    const h264 = { ...metadata, videoCodec: VideoCodec.H264 } as StreamMetadata;

    // The filter remembers the resolution per serial for the whole process, so every test that
    // depends on it uses a serial of its own.
    const run = async (
        meta: StreamMetadata,
        input: Buffer,
        camera: string,
    ): Promise<{ out: Buffer; infos: string[] }> => {
        const infos: string[] = [];
        const log = { ...createLog().log, info: (message: string) => infos.push(message) } as unknown as ioBrokerLogger;
        const filter = createVideoFilter(camera, meta, log);
        const out: Buffer[] = [];
        filter.on('data', (chunk: Buffer) => out.push(chunk));
        const ended = new Promise(resolve => filter.on('end', resolve));
        filter.end(input);
        await ended;
        return { out: Buffer.concat(out), infos: infos.filter(info => !info.includes('DEBUG')) };
    };
    const gop = Buffer.concat([sps, idr, p]);

    it('should hold back the first H.264 livestream of a device, whose resolution is not known yet', async () => {
        const { out, infos } = await run(h264, Buffer.concat([gop, gop]), 'T8-first');

        expect(out.length).to.equal(gop.length);
        expect(infos[0]).to.equal(
            `streamToGo2rtc(): T8-first - Livestream did not start with a clean keyframe at a known resolution, dropped ${gop.length} bytes up to the second keyframe (1600x1200)`,
        );
    });

    it('should hand on the next warm H.264 start of that device completely, with the level patched', async () => {
        await run(h264, Buffer.concat([gop, gop]), 'T8-warm');
        const { out, infos } = await run(h264, gop, 'T8-warm');

        expect(out.length).to.equal(gop.length);
        expect(out[4 + 3]).to.equal(40);
        expect(infos).to.deep.equal(['streamToGo2rtc(): T8-warm - Declared H.264 level 4.2 replaced with 4.0']);
    });

    it('should keep the known resolution of one device away from another one', async () => {
        await run(h264, Buffer.concat([gop, gop]), 'T8-a');
        const { out } = await run(h264, Buffer.concat([gop, gop]), 'T8-b');

        expect(out.length).to.equal(gop.length);
    });

    it('should drop a cold H.264 start up to its second keyframe', async () => {
        await run(h264, Buffer.concat([gop, gop]), 'T8-cold');
        const { out, infos } = await run(h264, Buffer.concat([p, gop, gop]), 'T8-cold');

        expect(out.length).to.equal(gop.length);
        expect(infos[0]).to.equal(
            `streamToGo2rtc(): T8-cold - Livestream did not start with a clean keyframe at 1600x1200, dropped ${p.length + gop.length} bytes up to the second keyframe (1600x1200)`,
        );
    });

    it('should hand on H.265 untouched, even when it does not start with parameter sets', async () => {
        const input = Buffer.concat([p, idr]);
        const { out } = await run(metadata, input, 'T8-h265');

        expect(out.equals(input)).to.equal(true);
    });
});
