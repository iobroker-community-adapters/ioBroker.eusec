import { expect } from 'chai';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';
import { AudioCodec, type StreamMetadata, VideoCodec } from 'eufy-security-client';

import type { ioBrokerLogger } from './log';
import { streamToGo2rtc } from './video';

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
