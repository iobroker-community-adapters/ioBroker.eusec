import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { CommandName, PropertyName, type Device, type Picture, type Station } from 'eufy-security-client';

/**
 * Returns the file extension to store an event picture under, or `undefined` when the picture
 * cannot be shown. eufy-security-client reports `ext: "unknown"` when it could not decrypt the
 * image or recognise its format; storing that would replace the last good picture with a
 * `<serial>.unknown` file no browser opens.
 *
 * @param picture picture emitted by eufy-security-client
 */
export const getPictureExtension = function (picture: Partial<Picture> | undefined): string | undefined {
    const ext = picture?.type?.ext;
    if (!ext || ext === 'unknown' || !Buffer.isBuffer(picture.data) || picture.data.length === 0) {
        return undefined;
    }
    return ext;
};

/**
 * Describes undecodable picture data for the log: its length and, for eufy's
 * `<format>:<serial>:...` blobs, the format prefix (e.g. `v8_eufysecurity`), so a report
 * tells which image format the client did not handle.
 *
 * @param data picture data emitted by eufy-security-client
 */
export const describePictureData = function (data: unknown): string {
    if (!Buffer.isBuffer(data) || data.length === 0) {
        return 'no data';
    }
    const colon = data.subarray(0, 32).indexOf(0x3a);
    const prefix = colon > 0 ? data.subarray(0, colon).toString('latin1') : '';
    return /^\w+$/.test(prefix)
        ? `${data.length} bytes, format "${prefix}"`
        : `${data.length} bytes, unrecognised format`;
};

/**
 * Asks the station for the device's latest picture over P2P, the way eufy-security-client loads
 * the picture on start (#136). The picture that comes with an event notification is downloaded
 * from the cloud, and in newer formats (`v8_eufysecurity`) it cannot be decrypted; the station
 * hands out the same picture in a decodable form. The client falls back to this only when the
 * cloud download is empty, not when it cannot be decoded.
 *
 * The query runs after the delay eufy-security-client uses (`getWaitSeconds`): 60 seconds, or the
 * custom clip length in working mode 2, because the station stores the picture only once the
 * recording has ended. One query per device is pending at a time.
 *
 * @param station station of the device
 * @param device device whose picture could not be decoded
 * @param pending serials of devices with a pending query, shared between calls
 * @param setTimer schedules the query; the adapter's own timer, which unload clears
 * @returns `false` when the station does not support the query
 */
export const schedulePictureOverP2P = function (
    station: Pick<Station, 'hasCommand' | 'databaseQueryLatestInfo'>,
    device: Pick<Device, 'getSerial' | 'getPropertyValue'>,
    pending: Set<string>,
    setTimer: (callback: () => void, ms: number) => unknown,
): boolean {
    if (!station.hasCommand(CommandName.StationDatabaseQueryLatestInfo)) {
        return false;
    }
    const serial = device.getSerial();
    if (pending.has(serial)) {
        return true;
    }
    const clipLength: unknown = device.getPropertyValue(PropertyName.DeviceRecordingClipLength);
    const seconds =
        device.getPropertyValue(PropertyName.DevicePowerWorkingMode) === 2 &&
        typeof clipLength === 'number' &&
        Number.isFinite(clipLength) &&
        clipLength > 0
            ? Math.min(clipLength, 300)
            : 60;
    pending.add(serial);
    setTimer(() => {
        pending.delete(serial);
        station.databaseQueryLatestInfo();
    }, seconds * 1000);
    return true;
};

/**
 * eufy-security-client's keyless decoder for `v2_eufysecurity` pictures. The package does not export
 * it, so it is loaded by its file path.
 */
const V2_DECODER = path.join(path.dirname(require.resolve('eufy-security-client')), 'http', 'decodeImageV2.js');

let fixedSizeV2Header: Buffer | undefined;

/**
 * Tells whether a picture is a `v2_eufysecurity` picture that eufy-security-client rebuilt at its
 * fixed size of 288x176. Such a picture hides its size in an encrypted header, which the client
 * replaces with a standard header of its own. For a picture the station sends over P2P, that header
 * always says 288x176 4:2:0, whatever the real size, so a larger picture turns into grey diagonal
 * streaks (forum topic 85382). Exactly those bytes start the picture then.
 *
 * @param data picture data the client decoded
 */
export const isFixedSizeV2Picture = function (data: unknown): data is Buffer {
    if (!Buffer.isBuffer(data)) {
        return false;
    }
    if (!fixedSizeV2Header) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const decoder = require(V2_DECODER) as { buildJpegPrefix: (w: number, h: number, s: string) => Buffer };
        fixedSizeV2Header = decoder.buildJpegPrefix(288, 176, '4:2:0');
    }
    return (
        data.length > fixedSizeV2Header.length && data.subarray(0, fixedSizeV2Header.length).equals(fixedSizeV2Header)
    );
};

/** Order in which a DQT segment lists the 64 coefficients of an 8x8 block. */
const ZIGZAG = [
    0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21,
    28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54,
    47, 55, 62, 63,
];

/** Luma and chroma quantization tables of quality 50 from the JPEG standard (Annex K), row by row. */
const BASE_TABLES = [
    [
        16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29,
        51, 87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121,
        120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
    ],
    [
        17,
        18,
        24,
        47,
        99,
        99,
        99,
        99,
        18,
        21,
        26,
        66,
        99,
        99,
        99,
        99,
        24,
        26,
        56,
        99,
        99,
        99,
        99,
        99,
        47,
        66,
        99,
        99,
        99,
        99,
        99,
        99,
        ...new Array<number>(32).fill(99),
    ],
];

/** Where the two DQT segments of the client's replacement header start; each holds 64 one-byte values. */
const DQT_OFFSETS = [20, 89];

/** Quality of the tables in the client's replacement header. */
const HEADER_QUALITY = 85;
/** Lowest quality the contrast estimate may pick, which stretches the picture 6.7 times. */
const MIN_QUALITY = 25;

/** libjpeg's scaling of the standard tables: percent of the quality 50 values. */
const qualityScale = (quality: number): number => (quality < 50 ? 5000 / quality : 200 - 2 * quality);

/**
 * Estimates the quality of the tables a picture was encoded with, from the histogram of its RGB
 * values decoded with the replacement tables of quality 85. Decoding is linear in the tables: tables
 * k times smaller than the real ones shrink every value's distance to 128 by k, which is why such a
 * picture looks grey and flat. The estimate is the largest k that keeps the darkest and the brightest
 * 0.1 % of the values within 5..250, turned into the libjpeg quality whose tables are k times those
 * of quality 85. A picture that already spans the full range keeps quality 85.
 *
 * Known limit: a picture that is flat for real, fog or night without the timestamp overlay, is
 * stretched too; MIN_QUALITY caps that.
 *
 * @param histogram count of each value 0..255 over the R, G and B channels
 * @returns libjpeg quality between MIN_QUALITY and 85
 */
export const contrastQuality = function (histogram: readonly number[]): number {
    const total = histogram.reduce((sum, count) => sum + count, 0);
    if (histogram.length !== 256 || !(total > 0)) {
        return HEADER_QUALITY;
    }
    const percentile = (share: number): number => {
        let seen = 0;
        for (let value = 0; value < 256; value++) {
            seen += histogram[value];
            if (seen >= share * total) {
                return value;
            }
        }
        return 255;
    };
    const stretch = Math.min(
        (250 - 128) / Math.max(1, percentile(0.999) - 128),
        (128 - 5) / Math.max(1, 128 - percentile(0.001)),
    );
    const scale = qualityScale(HEADER_QUALITY) * Math.max(1, stretch);
    const quality = Math.round(scale <= 100 ? 100 - scale / 2 : 5000 / scale);
    return Math.min(HEADER_QUALITY, Math.max(MIN_QUALITY, quality));
};

/**
 * Replaces the quantization tables of a picture rebuilt by the client with the standard tables of
 * another quality. Only the header changes; the scan is not encoded again.
 *
 * @param jpeg picture with the client's replacement header
 * @param quality libjpeg quality, 1..100
 * @returns a copy with the new tables, or the picture itself if its header is not the client's
 */
export const withQuality = function (jpeg: Buffer, quality: number): Buffer {
    const layout = DQT_OFFSETS.every(
        (offset, table) =>
            jpeg.length > offset + 69 && jpeg.readUInt32BE(offset) === 0xffdb0043 && jpeg[offset + 4] === table,
    );
    if (!layout || !(quality >= 1 && quality <= 100)) {
        return jpeg;
    }
    const scale = qualityScale(quality);
    const result = Buffer.from(jpeg);
    DQT_OFFSETS.forEach((offset, table) => {
        ZIGZAG.forEach((index, position) => {
            result[offset + 5 + position] = Math.min(
                255,
                Math.max(1, Math.floor((BASE_TABLES[table][index] * scale + 50) / 100)),
            );
        });
    });
    return result;
};

/**
 * Runs the client's size detection in a worker; see redecodeV2Picture. Sends the picture and the
 * histogram of its RGB values for contrastQuality.
 */
const REDECODE_WORKER = `
const path = require('node:path');
const { parentPort, workerData } = require('node:worker_threads');
const histogram = jpeg => {
    const jpegJs = require(require.resolve('jpeg-js', { paths: [path.dirname(workerData.decoder)] }));
    const { data } = jpegJs.decode(jpeg, { tolerantDecoding: true, maxResolutionInMP: 400, maxMemoryUsageInMB: 1024 });
    const counts = new Array(256).fill(0);
    for (let i = 0; i < data.length; i++) {
        if (i % 4 !== 3) counts[data[i]]++;
    }
    return counts;
};
require(workerData.decoder)
    .decodeV2ImageAuto(Buffer.from(workerData.data))
    .then(
        result => parentPort.postMessage(result ? { jpeg: result.jpeg, histogram: histogram(result.jpeg) } : null),
        () => parentPort.postMessage(null),
    );
`;

/**
 * Rebuilds a picture found by isFixedSizeV2Picture at its real size, with the size detection the
 * client applies to pictures it downloads from the cloud. The detection decodes the picture at up to
 * a hundred sizes and takes seconds, so it runs in a worker: streams and events go on meanwhile.
 *
 * The client's replacement header carries the standard tables of quality 85, while the real ones are
 * in the encrypted part. A P2P picture of a Video Doorbell (T8210) came out with its values squeezed
 * into 104..156, so the quality is estimated from the picture (contrastQuality) and its tables put in.
 *
 * @param data picture data the client rebuilt at 288x176
 * @returns the rebuilt picture, or `undefined` if the size could not be detected
 */
export const redecodeV2Picture = function (data: Buffer): Promise<Buffer | undefined> {
    return new Promise(resolve => {
        const worker = new Worker(REDECODE_WORKER, { eval: true, workerData: { decoder: V2_DECODER, data } });
        // A running detection must not keep the adapter from stopping.
        worker.unref();
        worker.once('message', (result: { jpeg: Uint8Array; histogram: number[] } | null) =>
            resolve(result ? withQuality(Buffer.from(result.jpeg), contrastQuality(result.histogram)) : undefined),
        );
        worker.once('error', () => resolve(undefined));
        worker.once('exit', () => resolve(undefined));
    });
};
