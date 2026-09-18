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
