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
