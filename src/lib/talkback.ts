/**
 * Talkback: plays an audio file or URL through the speaker of a camera or doorbell
 * (iobroker-community-adapters/ioBroker.eusec#34).
 *
 * eufy-security-client only starts talkback while the device is live streaming and then hands out a
 * TalkbackStream. Every chunk written to it is sent to the device as ONE audio frame, so the audio
 * has to arrive as single AAC frames (16 kHz, mono, ADTS) at the pace it is played. ffmpeg reads the
 * source in real time (`-re`) and encodes it, AdtsFramer cuts its output into frames.
 */

import { spawn } from 'node:child_process';
import { on, type EventEmitter } from 'node:events';
import path from 'node:path';
import { Transform, type TransformCallback, type Writable } from 'node:stream';

/** Length of an ADTS header without CRC; a frame can never be shorter. */
const ADTS_HEADER_LENGTH = 7;

/**
 * Cuts an ADTS byte stream into single frames. Bytes before a sync word are skipped, and an
 * incomplete frame at the end of the stream is dropped.
 */
export class AdtsFramer extends Transform {
    private pending: Buffer = Buffer.alloc(0);

    public _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
        this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
        let offset = 0;
        while (this.pending.length - offset >= ADTS_HEADER_LENGTH) {
            // Sync word: 12 bits set, then layer 00.
            if (this.pending[offset] !== 0xff || (this.pending[offset + 1] & 0xf6) !== 0xf0) {
                offset++;
                continue;
            }
            const frameLength =
                ((this.pending[offset + 3] & 0x03) << 11) |
                (this.pending[offset + 4] << 3) |
                (this.pending[offset + 5] >> 5);
            if (frameLength < ADTS_HEADER_LENGTH) {
                offset++;
                continue;
            }
            if (this.pending.length - offset < frameLength) {
                break;
            }
            this.push(this.pending.subarray(offset, offset + frameLength));
            offset += frameLength;
        }
        this.pending = this.pending.subarray(offset);
        callback();
    }
}

/**
 * Checks what was written to the talkback state. Only http(s) URLs and absolute file paths are
 * accepted, so the value can never select another ffmpeg protocol or be read as an option.
 *
 * @param value The state value
 * @returns The trimmed source, or undefined if it is not accepted
 */
export const parseTalkbackSource = (value: unknown): string | undefined => {
    if (typeof value !== 'string') {
        return undefined;
    }
    const source = value.trim();
    if (/^https?:\/\/[^\s]+$/i.test(source)) {
        return source;
    }
    if (path.isAbsolute(source) && !source.startsWith('-') && !/^[a-z][a-z0-9+.-]*:(?![\\/])/i.test(source)) {
        return source;
    }
    return undefined;
};

/**
 * Builds the ffmpeg arguments that turn the source into what the talkback stream expects.
 *
 * @param source A value returned by parseTalkbackSource()
 * @returns The arguments, the encoded audio goes to stdout
 */
export const talkbackFfmpegArgs = (source: string): string[] => [
    '-hide_banner',
    '-loglevel',
    'error',
    '-protocol_whitelist',
    'file,http,https,tcp,tls',
    '-re',
    '-i',
    source,
    '-vn',
    '-acodec',
    'aac',
    '-profile:a',
    'aac_low',
    '-ar',
    '16000',
    '-ac',
    '1',
    '-b:a',
    '20k',
    '-f',
    'adts',
    'pipe:1',
];

/**
 * Waits for an event of eufy-security-client whose second argument is the given device.
 *
 * @param emitter The EufySecurity instance
 * @param event The event name, e.g. "station talkback start"
 * @param serial The serial number of the device
 * @param timeoutMs How long to wait
 * @returns The event arguments
 */
export const waitForDeviceEvent = async (
    emitter: EventEmitter,
    event: string,
    serial: string,
    timeoutMs: number,
): Promise<unknown[]> => {
    try {
        // Leaving the loop, by return or by the timeout, removes the listener.
        for await (const args of on(emitter, event, { signal: AbortSignal.timeout(timeoutMs) })) {
            const device = (args as unknown[])[1] as { getSerial?: () => string } | undefined;
            if (device?.getSerial?.() === serial) {
                return args as unknown[];
            }
        }
    } catch (error) {
        if ((error as Error).name !== 'AbortError') {
            throw error;
        }
    }
    throw new Error(`No "${event}" for device ${serial} within ${timeoutMs / 1000} seconds`);
};

/**
 * Runs the encoder and writes its output frame by frame into the talkback stream, which is left open
 * because it belongs to the library.
 *
 * @param command The ffmpeg binary
 * @param args Arguments from talkbackFfmpegArgs()
 * @param talkbackStream The stream handed out with "station talkback start"
 * @param signal Stops the encoder early, e.g. when the livestream ends
 * @returns Resolves when the source was played or the signal fired, rejects if the encoder failed
 */
export const pipeToTalkback = (
    command: string,
    args: string[],
    talkbackStream: Writable,
    signal: AbortSignal,
): Promise<void> =>
    new Promise((resolve, reject) => {
        const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], signal });
        let stderr = '';
        child.stderr.on('data', (data: Buffer) => {
            stderr = (stderr + data.toString()).slice(-500);
        });
        child.stdout.pipe(new AdtsFramer()).pipe(talkbackStream, { end: false });
        child.on('error', error => (signal.aborted ? resolve() : reject(error)));
        child.on('close', code => {
            if (code === 0 || signal.aborted) {
                resolve();
            } else {
                reject(new Error(`ffmpeg exited with code ${code}: ${stderr.trim()}`));
            }
        });
    });
