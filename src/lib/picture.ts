import type { Picture } from 'eufy-security-client';

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
