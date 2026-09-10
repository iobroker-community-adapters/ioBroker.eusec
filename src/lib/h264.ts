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
 * Levels as `[level_idc, MaxFS, MaxMBPS, MaxDpbMbs]` from ITU-T H.264 table A-1, in ascending
 * order. MaxFS is the frame size in macroblocks, MaxMBPS the macroblock rate per second and
 * MaxDpbMbs the size of the decoded picture buffer in macroblocks.
 *
 * ponytail: the bitrate limit (MaxBR) of a level is not checked, because the raw stream carries no
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
 * Reads the geometry of an SPS and returns the level the stream really needs.
 *
 * @param sps The SPS NAL unit including its header byte, without the start code
 * @param fps Frame rate reported for the stream, used when it is above the assumed one
 * @returns The level_idc that fits, or undefined when the SPS cannot be read
 */
export const requiredLevel = (sps: Uint8Array, fps: number): number | undefined => {
    try {
        const reader = new BitReader(toRbsp(sps));
        reader.bits(8); // nal header
        const profile = reader.bits(8);
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
        const mbPerFrame = widthMbs * heightMbs;
        return pickLevel(mbPerFrame, mbPerFrame * Math.max(fps, ASSUMED_FPS), Math.max(refFrames, 1));
    } catch {
        return undefined;
    }
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
 * level the stream really needs. The level is worked out once, from the first SPS that can be
 * read, and then written into every following SPS - the cameras repeat the SPS before each
 * keyframe, and go2rtc builds the init segment from whichever one its consumer sees first.
 *
 * A stream whose SPS cannot be read passes through untouched.
 *
 * @param fps Frame rate reported for the stream
 * @param onLevel Called once with the old and the new level when the first SPS was read
 * @returns A transform stream to put in front of the go2rtc ingest
 */
export const createSpsLevelPatcher = (fps: number, onLevel?: (from: number, to: number) => void): Transform => {
    let carry: Buffer = Buffer.alloc(0);
    let level: number | undefined;
    let passthrough = false;
    let reportLevel = false;

    return new Transform({
        transform(chunk: Buffer, _encoding, callback): void {
            if (passthrough) {
                callback(null, chunk);
                return;
            }

            const buffer = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk;
            let pending = -1;

            for (let i = 0; i + 3 < buffer.length; i++) {
                if (buffer[i] !== 0 || buffer[i + 1] !== 0 || buffer[i + 2] !== 1) {
                    continue;
                }
                if ((buffer[i + 3] & 0x1f) !== NAL_TYPE_SPS) {
                    continue;
                }
                if (level === undefined) {
                    const end = nextStartCode(buffer, i + 3);
                    if (end < 0) {
                        // The SPS is not complete yet - hold it back until the rest arrives.
                        pending = i;
                        break;
                    }
                    level = requiredLevel(buffer.subarray(i + 3, end), fps);
                    if (level === undefined) {
                        passthrough = true;
                        break;
                    }
                    reportLevel = true;
                }
                if (i + 6 >= buffer.length) {
                    pending = i;
                    break;
                }
                if (reportLevel) {
                    reportLevel = false;
                    onLevel?.(buffer[i + 6], level);
                }
                buffer[i + 6] = level;
                i += 6;
            }

            if (passthrough) {
                carry = Buffer.alloc(0);
                callback(null, buffer);
                return;
            }

            if (pending < 0) {
                // Hold back a start code that may be split across chunks, plus the three bytes up
                // to the level of an SPS that begins right at the end of this chunk.
                pending = Math.max(0, buffer.length - 6);
            } else if (buffer.length - pending > MAX_PENDING_SPS) {
                // Whatever is at that offset never turned into a readable SPS. Stop looking
                // instead of buffering the whole livestream.
                passthrough = true;
                carry = Buffer.alloc(0);
                callback(null, buffer);
                return;
            }

            carry = Buffer.from(buffer.subarray(pending));
            callback(null, buffer.subarray(0, pending));
        },
        flush(callback): void {
            callback(null, carry);
        },
    });
};
