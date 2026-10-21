/**
 * Streaming quality of a livestream, resolved through the state labels of the library. Deliberately
 * free of adapter imports, so it stays testable without a running js-controller.
 */

/**
 * Label prefix of the "Auto" entries in DeviceVideoStreamingQualityProperty.states. The numeric
 * value behind it differs per device family - the base property and the S350 use 0, eufyCam 3 and
 * the Professional models use 5, and battery doorbells have both (0 = "Auto / Low Encoding",
 * 5 = "Auto / High Encoding") - so the value must be resolved through the label, not hardcoded.
 */
export const VIDEO_STREAMING_QUALITY_AUTO_LABEL = 'Auto';

/** Values of the setting "Livestream quality" and the state labels of the library they stand for. */
export const LIVESTREAM_QUALITY_LABELS: Record<string, string> = { low: 'Low', medium: 'Medium', high: 'High' };

/** The states of the streaming quality property: value -> label. */
export type QualityStates = Record<number, string>;

export type QualityChange =
    /** The setting is off, or the device already streams at the wanted quality. */
    | { kind: 'keep' }
    /** The device has no state with the wanted label, e.g. it names its qualities by resolution. */
    | { kind: 'unavailable'; wanted: string }
    | { kind: 'set'; value: number; from: string; to: string };

/**
 * Tells whether a label is one of the "Auto" qualities, where the camera is free to change the
 * resolution mid-stream.
 *
 * @param label The state label of the current quality
 * @returns true for "Auto" and "Auto / ... Encoding"
 */
export const isAutoStreamingQuality = (label: string | undefined): boolean =>
    typeof label === 'string' && label.startsWith(VIDEO_STREAMING_QUALITY_AUTO_LABEL);

/**
 * Lists the qualities of a device that are not "Auto", for the hint in the log.
 *
 * @param states The states of the streaming quality property
 * @returns e.g. "1 = Low, 2 = Medium, 3 = High"
 */
export const fixedStreamingQualities = (states: QualityStates | undefined): string =>
    Object.entries(states ?? {})
        .filter(([, label]) => !isAutoStreamingQuality(label))
        .map(([value, label]) => `${value} = ${label}`)
        .join(', ');

/**
 * Tells whether a label is one of the qualities Low, Medium or High, with or without an encoding.
 *
 * @param label The state label
 * @returns true for "Medium" and "Medium / Low Encoding", false for "1080P"
 */
const isNamedQuality = (label: string): boolean =>
    Object.values(LIVESTREAM_QUALITY_LABELS).some(name => label === name || label.startsWith(`${name} / `));

/**
 * Resolves the streaming quality a device has to be set to for the setting "Livestream quality".
 * A battery doorbell combines the quality with an encoding ("Medium / Low Encoding"), which is kept.
 * A device that names its qualities by resolution only ("HD (720P)", "Full HD (1080P)", "3K HD")
 * gets them in ascending order: low = the lowest, medium = the second, high = the third. A fourth
 * one ("Ultra 4K") stays out, like "Ultra 4K" next to "High" on the eufyCam 3.
 *
 * @param states The states of the streaming quality property of the device
 * @param value The current value of the property
 * @param setting The setting "Livestream quality": "", "low", "medium" or "high"
 * @returns What to do with the streaming quality of the device
 */
export const resolveStreamingQuality = (
    states: QualityStates | undefined,
    value: number,
    setting: string,
): QualityChange => {
    const wanted = LIVESTREAM_QUALITY_LABELS[setting];
    if (!wanted) {
        return { kind: 'keep' };
    }
    const current = states?.[value] ?? String(value);
    // Integer keys come out of Object.entries in ascending order, which is the order of the qualities.
    const entries = Object.entries(states ?? {});
    const fixed = entries.filter(([, label]) => !isAutoStreamingQuality(label));
    const encoding = current.includes(' / ') ? current.slice(current.indexOf(' / ')) : '';
    const target =
        entries.find(([, label]) => label === `${wanted}${encoding}`) ??
        entries.find(([, label]) => label === wanted) ??
        entries.find(([, label]) => label.startsWith(`${wanted} / `)) ??
        (fixed.some(([, label]) => isNamedQuality(label))
            ? undefined
            : fixed[Object.keys(LIVESTREAM_QUALITY_LABELS).indexOf(setting)]);
    if (!target) {
        return { kind: 'unavailable', wanted };
    }
    if (Number(target[0]) === value) {
        return { kind: 'keep' };
    }
    return { kind: 'set', value: Number(target[0]), from: current, to: target[1] };
};
