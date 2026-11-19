/**
 * The eufy cameras declare a fixed `level_idc` of 42 (level 4.2) in every SPS, no matter which
 * resolution `video_streaming_quality` actually selects. The level is a promise about the decoder
 * resources a stream needs, and go2rtc copies it straight into the avcC of the MSE init segment,
 * so the browser announces the stream to its decoder as `avc1.64002A`. Hardware decoders that stop
 * at level 4.0 size their reference picture buffers from that promise and then decode the stream
 * into green macroblocks, from the first frame on and without ever recovering.
 *
 * These helpers replace the declared level with the lowest one the stream really fits into. The
 * geometry is read from the SPS itself instead of `StreamMetadata`, because eufy-security-client
 * defaults `videoWidth`/`videoHeight` to 1920x1080 when the camera sends no metadata message - a
 * level derived from that would be too low for a bigger stream, which is worse than the fixed 42.
 */

import { Transform } from 'node:stream';

/** NAL unit type of a sequence parameter set. */
const NAL_TYPE_SPS = 7;

/**
 * Profiles that carry the chroma format block at the start of the SPS. From ITU-T H.264 7.3.2.1.1.
 */
const HIGH_PROFILES = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]);

/**
 * Every profile_idc the standard defines, the ones above plus baseline, main and extended. A byte
 * outside this set is not the start of an SPS, whatever the NAL header claimed.
 */
const PROFILES = new Set([66, 77, 88, ...HIGH_PROFILES]);

/**
 * Levels as `[level_idc, MaxFS, MaxMBPS, MaxDpbMbs]` from ITU-T H.264 table A-1, in ascending
 * order. MaxFS is the frame size in macroblocks, MaxMBPS the macroblock rate per second and
 * MaxDpbMbs the size of the decoded picture buffer in macroblocks.
 *
 * Known limit: the bitrate limit (MaxBR) of a level is not checked, because the raw stream carries no
 * bitrate and measuring it would mean buffering. Every level from 3.1 up allows at least
 * 14 Mbit/s, far above what these cameras produce. Add the check if a camera ever streams more.
 */
const LEVELS: ReadonlyArray<readonly [number, number, number, number]> = [
    [10, 99, 1485, 396],
    [11, 396, 3000, 900],
    [12, 396, 6000, 2376],
    [13, 396, 11880, 2376],
    [20, 396, 11880, 2376],
    [21, 792, 19800, 4752],
    [22, 1620, 20250, 8100],
    [30, 1620, 40500, 8100],
    [31, 3600, 108000, 18000],
    [32, 5120, 216000, 20480],
    [40, 8192, 245760, 32768],
    [41, 8192, 245760, 32768],
    [42, 8704, 522240, 34816],
    [50, 22080, 589824, 110400],
    [51, 36864, 983040, 184320],
    [52, 36864, 2073600, 184320],
];

/**
 * Frame rate the macroblock rate is calculated with when the camera reports a lower one. Reporting
 * too few frames per second would select too small a level, so the reported value is only ever
 * used when it is higher than this.
 */
const ASSUMED_FPS = 30;

/** Maximum number of bytes held back while waiting for the end of the first SPS. */
const MAX_PENDING_SPS = 4096;

/**
 * Reads the bits of an SPS in the order the syntax table defines them.
 */
class BitReader {
    private pos = 0;

    public constructor(private readonly data: Uint8Array) {}

    /**
     * Reads a single bit.
     *
     * @returns The bit
     */
    public bit(): number {
        const byte = this.data[this.pos >> 3];
        if (byte === undefined) {
            throw new Error('SPS truncated');
        }
        return (byte >> (7 - (this.pos++ & 7))) & 1;
    }

    /**
     * Reads a fixed number of bits, most significant first.
     *
     * @param count How many bits to read
     * @returns The value of those bits
     */
    public bits(count: number): number {
        let value = 0;
        for (let i = 0; i < count; i++) {
            value = (value << 1) | this.bit();
        }
        return value;
    }

    /**
     * Reads an unsigned Exp-Golomb coded value, `ue(v)` in the syntax table.
     *
     * @returns The decoded value
     */
    public ue(): number {
        let zeros = 0;
        while (this.bit() === 0) {
            if (++zeros > 31) {
                throw new Error('SPS malformed');
            }
        }
        return zeros === 0 ? 0 : (1 << zeros) - 1 + this.bits(zeros);
    }

    /**
     * Reads a signed Exp-Golomb coded value, `se(v)` in the syntax table.
     *
     * @returns The decoded value
     */
    public se(): number {
        const value = this.ue();
        return value & 1 ? (value + 1) >> 1 : -(value >> 1);
    }
}

/**
 * Removes the emulation prevention bytes an encoder inserts, so the bit reader sees the raw syntax
 * elements.
 *
 * @param nal The NAL unit including its header byte
 * @returns The raw byte sequence payload
 */
const toRbsp = (nal: Uint8Array): Uint8Array => {
    const out = new Uint8Array(nal.length);
    let length = 0;
    for (let i = 0; i < nal.length; i++) {
        if (i >= 2 && nal[i] === 3 && nal[i - 1] === 0 && nal[i - 2] === 0) {
            continue;
        }
        out[length++] = nal[i];
    }
    return out.subarray(0, length);
};

/**
 * Skips the scaling lists of an SPS, which carry no information this module needs.
 *
 * @param reader Reader positioned at the first scaling list
 * @param count Number of lists to skip
 */
const skipScalingLists = (reader: BitReader, count: number): void => {
    for (let i = 0; i < count; i++) {
        if (!reader.bit()) {
            continue;
        }
        let last = 8;
        let next = 8;
        for (let j = 0; j < (i < 6 ? 16 : 64); j++) {
            if (next !== 0) {
                next = (last + reader.se() + 256) % 256;
            }
            last = next === 0 ? last : next;
        }
    }
};

/**
 * Picks the lowest level a stream of that size fits into.
 *
 * @param mbPerFrame Macroblocks of one frame
 * @param mbPerSecond Macroblocks per second
 * @param refFrames Number of reference frames the SPS asks for
 * @returns The level_idc of the lowest matching level, or undefined if none fits
 */
const pickLevel = (mbPerFrame: number, mbPerSecond: number, refFrames: number): number | undefined =>
    LEVELS.find(
        ([, maxFs, maxMbps, maxDpb]) =>
            mbPerFrame <= maxFs && mbPerSecond <= maxMbps && refFrames * mbPerFrame <= maxDpb,
    )?.[0];

/**
 * Reads the geometry of an SPS.
 *
 * @param sps The SPS NAL unit including its header byte, without the start code
 * @returns Width and height in macroblocks and the reference frames, or undefined when the SPS cannot be read
 */
const readSps = (sps: Uint8Array): { widthMbs: number; heightMbs: number; refFrames: number } | undefined => {
    try {
        const reader = new BitReader(toRbsp(sps));
        reader.bits(8); // nal header
        const profile = reader.bits(8);
        if (!PROFILES.has(profile)) {
            return undefined;
        }
        reader.bits(16); // constraint flags, reserved bits and the level_idc that gets replaced
        reader.ue(); // seq_parameter_set_id
        if (HIGH_PROFILES.has(profile)) {
            const chromaFormat = reader.ue();
            if (chromaFormat === 3) {
                reader.bit(); // separate_colour_plane_flag
            }
            reader.ue(); // bit_depth_luma_minus8
            reader.ue(); // bit_depth_chroma_minus8
            reader.bit(); // qpprime_y_zero_transform_bypass_flag
            if (reader.bit()) {
                skipScalingLists(reader, chromaFormat === 3 ? 12 : 8);
            }
        }
        reader.ue(); // log2_max_frame_num_minus4
        const pocType = reader.ue();
        if (pocType === 0) {
            reader.ue(); // log2_max_pic_order_cnt_lsb_minus4
        } else if (pocType === 1) {
            reader.bit(); // delta_pic_order_always_zero_flag
            reader.se(); // offset_for_non_ref_pic
            reader.se(); // offset_for_top_to_bottom_field
            const cycle = reader.ue();
            for (let i = 0; i < cycle; i++) {
                reader.se(); // offset_for_ref_frame
            }
        }
        const refFrames = reader.ue(); // max_num_ref_frames
        reader.bit(); // gaps_in_frame_num_value_allowed_flag
        const widthMbs = reader.ue() + 1;
        const heightMapUnits = reader.ue() + 1;
        const heightMbs = (2 - reader.bit()) * heightMapUnits; // frame_mbs_only_flag
        return { widthMbs, heightMbs, refFrames };
    } catch {
        return undefined;
    }
};

/**
 * Reads the geometry of an SPS and returns the level the stream really needs.
 *
 * @param sps The SPS NAL unit including its header byte, without the start code
 * @param fps Frame rate reported for the stream, used when it is above the assumed one
 * @returns The level_idc that fits, or undefined when the SPS cannot be read
 */
export const requiredLevel = (sps: Uint8Array, fps: number): number | undefined => {
    const parsed = readSps(sps);
    if (!parsed) {
        return undefined;
    }
    const mbPerFrame = parsed.widthMbs * parsed.heightMbs;
    return pickLevel(mbPerFrame, mbPerFrame * Math.max(fps, ASSUMED_FPS), Math.max(parsed.refFrames, 1));
};

/**
 * Reads the picture size of an SPS, before cropping.
 *
 * @param sps The SPS NAL unit including its header byte, without the start code
 * @returns The size as `<width>x<height>`, or undefined when the SPS cannot be read
 */
export const spsGeometry = (sps: Uint8Array): string | undefined => {
    const parsed = readSps(sps);
    return parsed && `${parsed.widthMbs * 16}x${parsed.heightMbs * 16}`;
};

/**
 * Finds the next start code at or after an offset.
 *
 * @param buffer Buffer to search
 * @param from Offset to start at
 * @returns Index of the start code, or -1 if the buffer holds none
 */
const nextStartCode = (buffer: Buffer, from: number): number => {
    for (let i = from; i + 2 < buffer.length; i++) {
        if (buffer[i] === 0 && buffer[i + 1] === 0 && buffer[i + 2] === 1) {
            return i;
        }
    }
    return -1;
};

/**
 * Builds a stream that rewrites the declared level of every SPS of an Annex B H.264 stream to the
 * level the stream really needs. The cameras repeat the SPS before each keyframe and go2rtc builds
 * the init segment from whichever one its consumer sees first, so every one of them is looked at.
 *
 * Each SPS is judged on its own instead of deriving one level for the whole stream. A single SPS
 * that cannot be read - the first bytes after a freshly built P2P session are not always a clean
 * one - then costs nothing but that one SPS, where a cached level would be stamped into every
 * following SPS of the livestream.
 *
 * @param fps Frame rate reported for the stream
 * @param onLevel Called with the declared and the new level whenever the level changes
 * @returns A transform stream to put in front of the go2rtc ingest
 */
export const createSpsLevelPatcher = (fps: number, onLevel?: (from: number, to: number) => void): Transform => {
    let carry: Buffer = Buffer.alloc(0);
    let reported = 0;

    return new Transform({
        transform(chunk: Buffer, _encoding, callback): void {
            const buffer = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk;
            let pending = -1;

            for (let i = 0; i + 6 < buffer.length; i++) {
                if (buffer[i] !== 0 || buffer[i + 1] !== 0 || buffer[i + 2] !== 1) {
                    continue;
                }
                if ((buffer[i + 3] & 0x1f) !== NAL_TYPE_SPS) {
                    continue;
                }
                const end = nextStartCode(buffer, i + 3);
                if (end < 0) {
                    if (buffer.length - i <= MAX_PENDING_SPS) {
                        // The SPS is not complete yet - hold it back until the rest arrives.
                        pending = i;
                        break;
                    }
                    // Whatever is at that offset never turned into a readable SPS. Let it pass
                    // instead of buffering the whole livestream.
                    continue;
                }
                const level = requiredLevel(buffer.subarray(i + 3, end), fps);
                // Only ever lower a level that is declared too high. Raising one helps no decoder,
                // and it would let a single misread SPS claim more than the camera ever did.
                if (level === undefined || level >= buffer[i + 6]) {
                    continue;
                }
                if (level !== reported) {
                    reported = level;
                    onLevel?.(buffer[i + 6], level);
                }
                buffer[i + 6] = level;
                i = end - 1;
            }

            if (pending < 0) {
                // Hold back a start code that may be split across chunks, plus the three bytes up
                // to the level of an SPS that begins right at the end of this chunk.
                pending = Math.max(0, buffer.length - 6);
            }

            carry = Buffer.from(buffer.subarray(pending));
            callback(null, buffer.subarray(0, pending));
        },
        flush(callback): void {
            callback(null, carry);
        },
    });
};

/** NAL unit type of a slice of a picture that is not a keyframe. */
const NAL_TYPE_SLICE = 1;

/** NAL unit type of a slice of a keyframe (IDR picture). */
const NAL_TYPE_IDR = 5;

/** Bytes without any picture after which a stream counts as a cold start, not a warm one. */
const MAX_LEAD_IN = 64 * 1024;

/**
 * Reads the resolution of the SPS whose start code begins at an offset.
 *
 * @param buffer Buffer that holds the complete SPS and the start code after it
 * @param at Offset of its start code, three or four bytes
 * @returns The resolution, or undefined if the SPS cannot be read
 */
const geometryAt = (buffer: Buffer, at: number): string | undefined => {
    const header = nextStartCode(buffer, at) + 3;
    const end = nextStartCode(buffer, header);
    return end < 0 ? undefined : spsGeometry(buffer.subarray(header, end));
};

/**
 * Builds a stream that holds back the start of an Annex B H.264 stream that does not begin with a
 * clean keyframe in the expected resolution, until its second keyframe.
 *
 * A livestream can start with its first keyframe interval in another resolution - a Wall Light
 * Cam S100 that streams at 1600x1200 sent 1.4 s of 2048x1536 first. go2rtc builds its init segment from the first SPS and none for the switch, so
 * a browser keeps decoding with the wrong size and shows a frozen picture with a flickering
 * stripe at the top, or green blocks. Picture data before the first SPS, or an SPS that cannot be
 * read, ends the same way. A livestream that starts with a readable SPS of the expected size
 * followed by a keyframe is handed on untouched, so only the other ones pay for the wait.
 *
 * Known limit: a held-back start loses up to two keyframe intervals (about 2 s on the tested
 * cameras), also when no resolution is known yet or the quality setting was changed. A camera
 * whose first keyframe interval in the wrong resolution lasts longer than one interval still
 * reaches the player with the wrong size.
 *
 * @param expected Resolution (`<width>x<height>`) the last livestream of the device ran at, if known
 * @param onOpen Called once when the stream is handed on, with the resolution of the SPS in front of the keyframe it opens at (undefined if none or unreadable) and the bytes dropped before it (0 for a warm start)
 * @returns A transform stream to put in front of go2rtc
 */
export const createKeyframeGate = (
    expected: string | undefined,
    onOpen?: (geometry: string | undefined, dropped: number) => void,
): Transform => {
    let carry: Buffer = Buffer.alloc(0);
    let dropped = 0;
    let keyframes = 0;
    let open = false;
    // Whether the stream was judged yet. That happens at its first picture: a warm start has a
    // readable SPS of the expected size in front of it and begins with a keyframe.
    let judged = false;
    // Resolution of the last SPS before the first picture, undefined if it could not be read.
    let leading: string | undefined;
    // Start of the SPS that leads the next picture, so the second keyframe is handed on together
    // with the parameter sets go2rtc needs to build its init segment. Offset into the carry.
    let unit = -1;
    // First offset of the carry not looked at yet, so no NAL unit is counted twice.
    let resume = 0;

    return new Transform({
        transform(chunk: Buffer, _encoding, callback): void {
            if (open) {
                callback(null, chunk);
                return;
            }
            const buffer = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk;

            let i = resume;
            for (; i + 4 < buffer.length; i++) {
                if (buffer[i] !== 0 || buffer[i + 1] !== 0 || buffer[i + 2] !== 1) {
                    continue;
                }
                const type = buffer[i + 3] & 0x1f;
                const start = i > 0 && buffer[i - 1] === 0 ? i - 1 : i;
                // Only the first slice of a picture has first_mb_in_slice 0, which is coded as the
                // single bit 1. The other slices of the same keyframe must not count.
                const keyframe = type === NAL_TYPE_IDR && (buffer[i + 4] & 0x80) !== 0;
                if (type === NAL_TYPE_SPS) {
                    unit = unit < 0 ? start : unit;
                    if (!judged) {
                        const end = nextStartCode(buffer, i + 3);
                        if (end < 0) {
                            // The SPS is not complete yet - judge it once the rest arrived.
                            break;
                        }
                        leading = spsGeometry(buffer.subarray(i + 3, end));
                    }
                } else if (type === NAL_TYPE_SLICE || type === NAL_TYPE_IDR) {
                    if (!judged) {
                        judged = true;
                        if (keyframe && leading !== undefined && leading === expected) {
                            open = true;
                            carry = Buffer.alloc(0);
                            onOpen?.(leading, 0);
                            callback(null, buffer);
                            return;
                        }
                    }
                    if (keyframe && ++keyframes === 2) {
                        const from = unit < 0 ? start : unit;
                        open = true;
                        carry = Buffer.alloc(0);
                        onOpen?.(unit < 0 ? undefined : geometryAt(buffer, unit), dropped + from);
                        callback(null, buffer.subarray(from));
                        return;
                    }
                    unit = -1;
                }
                i += 3;
            }

            // Keep a start code that may be split across chunks, with the zero byte that can lead
            // it and the byte after its NAL header, or the SPS that may lead the second keyframe.
            // Before the first picture everything is kept, so a warm start loses no byte - unless
            // so much arrived without a picture that it cannot be the start of a clean stream.
            if (!judged && buffer.length > MAX_LEAD_IN) {
                judged = true;
            }
            const keep = !judged ? 0 : unit < 0 ? Math.max(0, buffer.length - 5) : unit;
            dropped += keep;
            carry = Buffer.from(buffer.subarray(keep));
            unit = unit < 0 ? -1 : unit - keep;
            resume = Math.max(0, i - keep);
            callback();
        },
    });
};
