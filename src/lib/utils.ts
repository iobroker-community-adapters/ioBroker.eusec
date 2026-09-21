import path from 'node:path';
import util from 'node:util';

import type { ioBrokerLogger } from './log';

/**
 * Writes a status value if it changed. A failed write is ignored, as it always was meant to be:
 * the value is written again with the next change.
 *
 * @param adapter The adapter instance
 * @param id The state id
 * @param value The value, null or undefined clear the state
 */
export const setStateChangedAsync = async function (adapter: ioBroker.Adapter, id: string, value: any): Promise<void> {
    await adapter
        .setStateChangedAsync(id, value === undefined || value === null ? null : { val: value, ack: true })
        .catch(() => {});
};

/**
 * Converts a property value to what its state stores: objects become JSON for string and object
 * states, everything else is passed through.
 *
 * @param type common.type of the state
 * @param value The property value
 * @returns The state value
 */
export const toStateValue = (type: string | undefined, value: unknown): unknown =>
    (type === 'string' || type === 'object') && typeof value === 'object' ? JSON.stringify(value) : value;

/**
 * Writes a changed property of a device or station to its state. The state is addressed by id, so
 * a state that exists without a value yet - one whose property had no value when it was created -
 * receives the update too.
 *
 * @param adapter The adapter instance
 * @param id The id of the property state
 * @param name The property name, it has to match native.name of the state
 * @param value The new property value
 * @returns true if the state was written, false if the adapter has no state for that property
 */
export const setPropertyState = async function (
    adapter: ioBroker.Adapter,
    id: string,
    name: string,
    value: unknown,
): Promise<boolean> {
    const obj = await adapter.getObjectAsync(id);
    if (obj?.native?.name !== name) {
        return false;
    }
    await setStateChangedAsync(adapter, id, toStateValue(obj.common.type, value));
    return true;
};

/** Parts of common that js-controller keeps on setObject() and that other adapters or the user own. */
const PRESERVED_COMMON = ['custom', 'smartName', 'material', 'habpanel', 'mobile'];

/**
 * Tells whether the stored common of an object differs from the one the adapter would write. The
 * stored one comes from the database, which drops every key whose value is undefined, so the
 * wanted one is compared as it would be stored.
 *
 * @param stored common as read from the objects database
 * @param wanted common as built by the adapter
 * @returns true if the object has to be written
 */
export const commonChanged = (stored: object, wanted: object): boolean => {
    const comparable = (common: object): Record<string, unknown> =>
        Object.fromEntries(
            Object.entries(JSON.parse(JSON.stringify(common)) as Record<string, unknown>).filter(
                ([key]) => !PRESERVED_COMMON.includes(key),
            ),
        );
    return !util.isDeepStrictEqual(comparable(stored), comparable(wanted));
};

export const getImageAsHTML = function (data: Buffer, mime = 'image/jpg'): string {
    if (data && data.length > 0) {
        return `<img src="data:${mime};base64,${data.toString('base64')}" style="width: auto ;height: 100%;" />`;
    }
    return '';
};

export const removeFiles = async function (
    adapter: ioBroker.Adapter,
    stationSerial: string,
    folderName: string,
    device_sn: string,
): Promise<void> {
    try {
        const dir_path = path.join(stationSerial, folderName);
        if (await adapter.fileExistsAsync(adapter.namespace, dir_path)) {
            const files = (await adapter.readDirAsync(adapter.namespace, dir_path)).filter(fn =>
                fn.file.startsWith(device_sn),
            );
            try {
                for (const filename of files) {
                    await adapter.delFileAsync(adapter.namespace, path.join(dir_path, filename.file));
                }
            } catch {
                // ignore
            }
        }
    } catch (error) {
        throw new Error(`Failed to remove files: ${error as Error}`);
    }
};

/**
 * Compares two adapter versions part by part. A pre-release suffix ("-alpha.0") is ignored and a
 * missing part counts as 0.
 *
 * @param a A version like "3.10.0"
 * @param b A version like "3.9.0"
 * @returns A negative number if a is older, 0 if both are equal, a positive number if a is newer
 */
export const compareVersions = (a: string, b: string): number => {
    const parts = (version: string): number[] =>
        version
            .split('-')[0]
            .split('.')
            .map(part => Number.parseInt(part, 10) || 0);
    const pa = parts(a);
    const pb = parts(b);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
        if (diff !== 0) {
            return diff;
        }
    }
    return 0;
};

export const deleteStates = async function (adapter: ioBroker.Adapter, property: string): Promise<void> {
    const states = await adapter.getStatesAsync(`*.${property}`);
    if (states) {
        const ids = Object.keys(states);
        for (const id of ids) {
            await adapter.delObjectAsync(id).catch(() => {});
        }
    }
};

/**
 * Runs the migrations between two adapter versions.
 *
 * @param adapter The adapter instance
 * @param log The logger
 * @param oldVersion The version that ran before, "" on a fresh installation
 */
export const handleUpdate = async function (
    adapter: ioBroker.Adapter,
    log: ioBrokerLogger,
    oldVersion: string,
): Promise<void> {
    if (oldVersion === '') {
        return;
    }
    if (compareVersions(oldVersion, '0.6.1') <= 0) {
        try {
            const all = await adapter.getStatesAsync('T*');
            if (all) {
                const ids = Object.keys(all);
                for (const id of ids) {
                    await adapter.delObjectAsync(id, { recursive: false }).catch(() => {});
                }
            }
            const channels = await adapter.getChannelsOfAsync();
            if (channels) {
                for (const channel of channels) {
                    if (channel.common.name !== 'info') {
                        await adapter.delObjectAsync(channel._id, { recursive: false }).catch(() => {});
                    }
                }
            }
            const devices = await adapter.getDevicesAsync();
            if (devices) {
                for (const device of devices) {
                    await adapter.delObjectAsync(device._id, { recursive: false }).catch(() => {});
                }
            }
        } catch (error) {
            log.error('Version 0.6.1: Error:', error);
        }
    }
    if (compareVersions(oldVersion, '0.7.4') <= 0) {
        try {
            await adapter.setObjectAsync('verify_code', {
                type: 'state',
                common: {
                    name: '2FA verification code',
                    type: 'string',
                    role: 'state',
                    read: true,
                    write: true,
                },
                native: {},
            });
        } catch (error) {
            log.error('Version 0.7.4: Error:', error);
        }
    }
    if (compareVersions(oldVersion, '1.0.0') <= 0) {
        for (const state of ['last_event_pic_url', 'last_event_pic_html', 'last_event_video_url']) {
            try {
                await deleteStates(adapter, state);
            } catch (error) {
                log.error(`Version 1.0.0 - ${state}: Error:`, error);
            }
        }
    }
    if (compareVersions(oldVersion, '3.2.1') <= 0) {
        // set_privacy_angle was created with the name of set_default_angle. A name the user changed
        // is left alone.
        try {
            const objects = await adapter.getAdapterObjectsAsync();
            for (const [id, obj] of Object.entries(objects)) {
                if (id.endsWith('.set_privacy_angle') && obj.common?.name === 'Set Default Angle') {
                    await adapter.extendObjectAsync(id, { common: { name: 'Set Privacy Angle' } });
                }
            }
        } catch (error) {
            log.error('Version 3.2.1 - set_privacy_angle: Error:', error);
        }
        // The tilt down button was created as "titl_down". The object moves to "tilt_down" with its
        // name and custom settings; scripts that use the old id have to be adapted.
        try {
            const objects = await adapter.getAdapterObjectsAsync();
            for (const [id, obj] of Object.entries(objects)) {
                if (!id.endsWith('.titl_down')) {
                    continue;
                }
                const newId = `${id.slice(0, -'titl_down'.length)}tilt_down`;
                if (objects[newId] === undefined) {
                    await adapter.setObjectAsync(newId, { ...obj, _id: newId });
                }
                await adapter.delObjectAsync(id);
            }
        } catch (error) {
            log.error('Version 3.2.1 - titl_down: Error:', error);
        }
    }
};

/**
 * Deletes the channels named "unknown" that hold no objects any more. The channels are found among
 * all objects of the instance, so a state without a value still counts as content.
 *
 * @param adapter The adapter instance
 */
export const deleteEmptyUnknownChannels = async function (adapter: ioBroker.Adapter): Promise<void> {
    const objects = await adapter.getAdapterObjectsAsync();
    const ids = Object.keys(objects);
    for (const [id, obj] of Object.entries(objects)) {
        if (
            obj.type === 'channel' &&
            obj.common?.name === 'unknown' &&
            !ids.some(other => other.startsWith(`${id}.`))
        ) {
            await adapter.delObjectAsync(id);
        }
    }
};

export const convertCamelCaseToSnakeCase = function (value: string): string {
    return value.replace(/[A-Z]/g, (letter, index) => {
        return index == 0 ? letter.toLowerCase() : `_${letter.toLowerCase()}`;
    });
};

export function getShortUrl(url: URL, prefixUrl?: string): string {
    if (url.password) {
        url = new URL(url.toString()); // prevent original url mutation
        url.password = '[redacted]';
    }
    let shortUrl = url.toString();
    if (prefixUrl && shortUrl.startsWith(prefixUrl)) {
        shortUrl = shortUrl.slice(prefixUrl.length);
    }

    return shortUrl;
}
