import { expect } from 'chai';
import path from 'node:path';
import jpegJs from 'jpeg-js';
import { CommandName, PropertyName, type Picture, type PropertyValue } from 'eufy-security-client';

import {
    contrastQuality,
    describePictureData,
    getPictureExtension,
    isFixedSizeV2Picture,
    redecodeV2Picture,
    schedulePictureOverP2P,
    withQuality,
} from './picture';

const JPEG_HEAD = Buffer.from('ffd8ffe000104a464946', 'hex');

describe('picture => getPictureExtension', () => {
    it('should return the extension of a recognised picture', () => {
        const picture: Picture = { data: JPEG_HEAD, type: { ext: 'jpg', mime: 'image/jpeg' } };
        expect(getPictureExtension(picture)).to.equal('jpg');
    });

    it('should accept a picture of a single byte', () => {
        const picture: Picture = { data: Buffer.from([0xff]), type: { ext: 'png', mime: 'image/png' } };
        expect(getPictureExtension(picture)).to.equal('png');
    });

    it('should reject a picture the client could not decode (#136)', () => {
        const picture: Picture = {
            data: Buffer.from('6575667973656375726974790000', 'hex'),
            type: { ext: 'unknown', mime: 'application/octet-stream' },
        };
        expect(getPictureExtension(picture)).to.equal(undefined);
    });

    it('should reject an empty picture', () => {
        const picture: Picture = { data: Buffer.alloc(0), type: { ext: 'jpg', mime: 'image/jpeg' } };
        expect(getPictureExtension(picture)).to.equal(undefined);
    });

    it('should reject a picture without type, extension or data', () => {
        expect(getPictureExtension(undefined)).to.equal(undefined);
        expect(getPictureExtension({ data: JPEG_HEAD })).to.equal(undefined);
        expect(getPictureExtension({ data: JPEG_HEAD, type: { ext: '' as 'jpg', mime: '' } })).to.equal(undefined);
        expect(getPictureExtension({ type: { ext: 'jpg', mime: 'image/jpeg' } })).to.equal(undefined);
        expect(
            getPictureExtension({ data: 'ffd8' as unknown as Buffer, type: { ext: 'jpg', mime: 'image/jpeg' } }),
        ).to.equal(undefined);
    });
});

describe('picture => describePictureData', () => {
    it('should name the eufy format prefix and the length (#136)', () => {
        const data = Buffer.concat([
            Buffer.from('v8_eufysecurity:T8030P2323250791:', 'latin1'),
            Buffer.from([0x0b, 0x02, 0x3a]),
        ]);
        expect(describePictureData(data)).to.equal(`${data.length} bytes, format "v8_eufysecurity"`);
    });

    it('should name the legacy prefix without version', () => {
        expect(describePictureData(Buffer.from('eufysecurity:T8113:', 'latin1'))).to.equal(
            '19 bytes, format "eufysecurity"',
        );
    });

    it('should not report binary data or a late colon as a format', () => {
        expect(describePictureData(Buffer.from('ffd8ff3a', 'hex'))).to.equal('4 bytes, unrecognised format');
        expect(describePictureData(Buffer.from(':abc', 'latin1'))).to.equal('4 bytes, unrecognised format');
        expect(describePictureData(Buffer.from(`${'a'.repeat(32)}:`, 'latin1'))).to.equal(
            '33 bytes, unrecognised format',
        );
        expect(describePictureData(Buffer.from([0x41]))).to.equal('1 bytes, unrecognised format');
    });

    it('should handle missing or empty data', () => {
        expect(describePictureData(undefined)).to.equal('no data');
        expect(describePictureData(Buffer.alloc(0))).to.equal('no data');
        expect(describePictureData('v8_eufysecurity:')).to.equal('no data');
    });
});

interface Fakes {
    queries: string[];
    timers: { callback: () => void; ms: number }[];
    station: { hasCommand: (command: CommandName) => boolean; databaseQueryLatestInfo: () => void };
    device: { getSerial: () => string; getPropertyValue: (name: PropertyName) => PropertyValue };
    setTimer: (callback: () => void, ms: number) => void;
}

describe('picture => schedulePictureOverP2P', () => {
    const fakes = function (
        properties: Record<string, unknown> = {},
        commands = [CommandName.StationDatabaseQueryLatestInfo],
    ): Fakes {
        const queries: string[] = [];
        const timers: { callback: () => void; ms: number }[] = [];
        return {
            queries,
            timers,
            station: {
                hasCommand: (command: CommandName): boolean => commands.includes(command),
                databaseQueryLatestInfo: (): void => void queries.push('query'),
            },
            device: {
                getSerial: (): string => 'T8113',
                // Boundary data from the client is untyped; the fake hands out invalid values on purpose.
                getPropertyValue: (name: PropertyName): PropertyValue => properties[name] as PropertyValue,
            },
            setTimer: (callback: () => void, ms: number): void => void timers.push({ callback, ms }),
        };
    };

    it('should query the station over P2P after 60 seconds by default (#136)', () => {
        const f = fakes();
        expect(schedulePictureOverP2P(f.station, f.device, new Set(), f.setTimer)).to.equal(true);
        expect(f.timers.map(t => t.ms)).to.deep.equal([60_000]);
        expect(f.queries).to.deep.equal([]);
        f.timers[0].callback();
        expect(f.queries).to.deep.equal(['query']);
    });

    it('should wait for the custom clip length in working mode 2', () => {
        const f = fakes({ [PropertyName.DevicePowerWorkingMode]: 2, [PropertyName.DeviceRecordingClipLength]: 5 });
        schedulePictureOverP2P(f.station, f.device, new Set(), f.setTimer);
        expect(f.timers[0].ms).to.equal(5_000);
    });

    it('should ignore the clip length outside working mode 2', () => {
        const f = fakes({ [PropertyName.DevicePowerWorkingMode]: 1, [PropertyName.DeviceRecordingClipLength]: 5 });
        schedulePictureOverP2P(f.station, f.device, new Set(), f.setTimer);
        expect(f.timers[0].ms).to.equal(60_000);
    });

    it('should fall back to 60 seconds for an invalid clip length and cap a huge one', () => {
        for (const clipLength of [0, -5, NaN, Infinity, '30', undefined]) {
            const f = fakes({
                [PropertyName.DevicePowerWorkingMode]: 2,
                [PropertyName.DeviceRecordingClipLength]: clipLength,
            });
            schedulePictureOverP2P(f.station, f.device, new Set(), f.setTimer);
            expect(f.timers[0].ms, String(clipLength)).to.equal(60_000);
        }
        const f = fakes({
            [PropertyName.DevicePowerWorkingMode]: 2,
            [PropertyName.DeviceRecordingClipLength]: 100_000,
        });
        schedulePictureOverP2P(f.station, f.device, new Set(), f.setTimer);
        expect(f.timers[0].ms).to.equal(300_000);
    });

    it('should not schedule a second query while one is pending, but again after it ran', () => {
        const f = fakes();
        const pending = new Set<string>();
        expect(schedulePictureOverP2P(f.station, f.device, pending, f.setTimer)).to.equal(true);
        expect(schedulePictureOverP2P(f.station, f.device, pending, f.setTimer)).to.equal(true);
        expect(f.timers).to.have.length(1);
        f.timers[0].callback();
        expect(pending.size).to.equal(0);
        schedulePictureOverP2P(f.station, f.device, pending, f.setTimer);
        expect(f.timers).to.have.length(2);
    });

    it('should not schedule anything for a station without the P2P picture query', () => {
        const f = fakes({}, []);
        expect(schedulePictureOverP2P(f.station, f.device, new Set(), f.setTimer)).to.equal(false);
        expect(f.timers).to.deep.equal([]);
    });
});

/** eufy-security-client's v2 decoder, loaded by its file path because the package does not export it. */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const v2Decoder = require(
    path.join(path.dirname(require.resolve('eufy-security-client')), 'http', 'decodeImageV2.js'),
) as { spliceV2Image: (data: Buffer, width: number, height: number, subsampling: string) => Buffer };

/**
 * Builds a `v2_eufysecurity` picture of the given size the way a station sends it: the JPEG header
 * up to the chroma Huffman tables replaced by bytes the client cannot read, the rest left plain.
 * The content is smooth and not periodic, like a camera picture; a periodic pattern would let the
 * size detection settle on a wrong width. Also returns what the client's P2P path makes of it.
 *
 * @param width width of the picture
 * @param height height of the picture
 * @param quality quality the picture is encoded with
 */
export const buildV2Picture = function (
    width: number,
    height: number,
    quality = 85,
): { blob: Buffer; rebuiltAt288x176: Buffer } {
    const pixels = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const edge = y > height / 2 && x > width / 3 && x < width / 2 ? 60 : 0;
            const value = 128 + 50 * Math.sin(x / 29 + y / 53) + 40 * Math.cos(y / 17 - (x * x) / 9000) + edge;
            pixels.fill(Math.max(0, Math.min(255, Math.round(value))), (y * width + x) * 4, (y * width + x) * 4 + 3);
            pixels[(y * width + x) * 4 + 3] = 255;
        }
    }
    const jpeg = jpegJs.encode({ data: pixels, width, height }, quality).data;
    // jpeg-js writes the four Huffman tables into one segment, eufy one segment per table. The DC and
    // AC luma tables take 29 and 179 bytes, the DC and AC chroma tables follow.
    const dht = jpeg.indexOf(Buffer.from([0xff, 0xc4]));
    const tables = dht + 4;
    const plain = Buffer.concat([
        Buffer.from('ffc4001f', 'hex'),
        jpeg.subarray(tables + 208, tables + 237),
        Buffer.from('ffc400b5', 'hex'),
        jpeg.subarray(tables + 237, tables + 416),
        jpeg.subarray(dht + 2 + jpeg.readUInt16BE(dht + 2)),
    ]);
    const blob = Buffer.concat([
        Buffer.from('v2_eufysecurity:T8210P0000000000:0123456789:', 'latin1'),
        Buffer.alloc(300, 0xa5),
        plain,
    ]);
    return { blob, rebuiltAt288x176: v2Decoder.spliceV2Image(blob, 288, 176, '4:2:0') };
};

/** Width, height and luma sampling factor from the SOF0 segment of a JPEG. */
export const jpegGeometry = function (jpeg: Buffer): [number, number, number] {
    const sof = jpeg.indexOf(Buffer.from([0xff, 0xc0]));
    return [jpeg.readUInt16BE(sof + 7), jpeg.readUInt16BE(sof + 5), jpeg[sof + 11]];
};

describe('picture => isFixedSizeV2Picture', () => {
    const { blob, rebuiltAt288x176 } = buildV2Picture(400, 304);
    // Header of the 288x176 rebuild: everything before the blob's plain chroma Huffman tables.
    const header = rebuiltAt288x176.subarray(0, rebuiltAt288x176.indexOf(Buffer.from('ffc4001f01', 'hex')));

    it('should recognise a picture the client rebuilt at 288x176', () => {
        expect(jpegGeometry(rebuiltAt288x176)).to.deep.equal([288, 176, 0x22]);
        expect(isFixedSizeV2Picture(rebuiltAt288x176)).to.equal(true);
        expect(isFixedSizeV2Picture(Buffer.concat([header, Buffer.from([0xff])])), 'one byte after it').to.equal(true);
    });

    it('should leave the raw blob, ordinary JPEGs and other sizes alone', () => {
        expect(isFixedSizeV2Picture(blob)).to.equal(false);
        expect(
            isFixedSizeV2Picture(jpegJs.encode({ data: Buffer.alloc(16 * 16 * 4), width: 16, height: 16 }).data),
        ).to.equal(false);
        const otherSize = Buffer.from(rebuiltAt288x176);
        otherSize.writeUInt16BE(800, otherSize.indexOf(Buffer.from([0xff, 0xc0])) + 7);
        expect(jpegGeometry(otherSize)[0]).to.equal(800);
        expect(isFixedSizeV2Picture(otherSize)).to.equal(false);
    });

    it('should reject the header alone, empty data and data that is no buffer', () => {
        expect(isFixedSizeV2Picture(header), 'header without scan').to.equal(false);
        expect(isFixedSizeV2Picture(header.subarray(0, 10))).to.equal(false);
        expect(isFixedSizeV2Picture(Buffer.alloc(0))).to.equal(false);
        expect(isFixedSizeV2Picture(undefined)).to.equal(false);
        expect(isFixedSizeV2Picture(null)).to.equal(false);
        expect(isFixedSizeV2Picture(rebuiltAt288x176.toString('latin1'))).to.equal(false);
        expect(isFixedSizeV2Picture(new Uint8Array(rebuiltAt288x176))).to.equal(false);
    });
});

describe('picture => redecodeV2Picture', function () {
    // The size detection decodes the picture at up to a hundred sizes.
    this.timeout(30000);

    it('should rebuild a 400x304 picture at its real size (forum topic 85382)', async () => {
        const rebuilt = await redecodeV2Picture(buildV2Picture(400, 304).rebuiltAt288x176);
        expect(rebuilt).to.be.instanceOf(Buffer);
        expect(jpegGeometry(rebuilt!).slice(0, 2)).to.deep.equal([400, 304]);
        expect(rebuilt!.subarray(-2).toString('hex'), 'a complete JPEG').to.equal('ffd9');
    });

    it('should return undefined for data without a plain JPEG scan', async () => {
        const { rebuiltAt288x176 } = buildV2Picture(400, 304);
        const header = rebuiltAt288x176.subarray(0, rebuiltAt288x176.indexOf(Buffer.from('ffc4001f01', 'hex')));
        expect(await redecodeV2Picture(Buffer.concat([header, Buffer.alloc(64, 0x11)]))).to.equal(undefined);
        expect(await redecodeV2Picture(Buffer.alloc(0))).to.equal(undefined);
    });
});

/** Histogram with the same count for every value from `low` to `high`. */
const flatHistogram = (low: number, high: number): number[] =>
    Array.from({ length: 256 }, (_, value) => (value >= low && value <= high ? 100 : 0));

describe('picture => contrastQuality', () => {
    it('should keep quality 85 for a picture that spans the full range', () => {
        expect(contrastQuality(flatHistogram(0, 255))).to.equal(85);
        expect(contrastQuality(flatHistogram(5, 250)), 'exactly the target range').to.equal(85);
    });

    it('should estimate the quality of a picture squeezed around 128 (forum topic 85382)', () => {
        // Values of the T8210 picture decoded with the quality 85 tables: 0.1 % at 110 and below,
        // 0.1 % at 150 and above. Its own tables are about those of quality 30.
        const histogram = flatHistogram(111, 149);
        histogram[110] = 4;
        histogram[150] = 4;
        expect(contrastQuality(histogram)).to.equal(30);
    });

    it('should let the side closer to its limit decide', () => {
        // A dark picture: stretching it 5.1 times takes its darkest values to 5, its brightest only to 179.
        expect(contrastQuality(flatHistogram(104, 138))).to.equal(contrastQuality(flatHistogram(104, 152)));
        expect(contrastQuality(flatHistogram(104, 138))).to.equal(33);
    });

    it('should not stretch more than MIN_QUALITY allows', () => {
        expect(contrastQuality(flatHistogram(128, 128))).to.equal(25);
        expect(contrastQuality(flatHistogram(125, 131))).to.equal(25);
    });

    it('should keep quality 85 for a histogram it cannot use', () => {
        expect(contrastQuality([])).to.equal(85);
        expect(contrastQuality(new Array<number>(256).fill(0))).to.equal(85);
        expect(contrastQuality(flatHistogram(120, 136).slice(0, 255)), '255 entries').to.equal(85);
        expect(contrastQuality(flatHistogram(120, 136).map(() => NaN))).to.equal(85);
    });
});

describe('picture => withQuality', () => {
    const { rebuiltAt288x176 } = buildV2Picture(400, 304);
    const luma = (jpeg: Buffer): number[] => [...jpeg.subarray(25, 89)];
    const chroma = (jpeg: Buffer): number[] => [...jpeg.subarray(94, 158)];

    it('should reproduce the tables of the client header for quality 85', () => {
        const same = withQuality(rebuiltAt288x176, 85);
        expect(same).to.not.equal(rebuiltAt288x176);
        expect(same.equals(rebuiltAt288x176)).to.equal(true);
    });

    it('should write the standard tables of another quality and leave the rest alone', () => {
        const q50 = withQuality(rebuiltAt288x176, 50);
        expect(luma(q50).slice(0, 6), 'Annex K luma table in zigzag order').to.deep.equal([16, 11, 12, 14, 12, 10]);
        expect(chroma(q50).slice(0, 6)).to.deep.equal([17, 18, 18, 24, 21, 24]);
        expect(Math.max(...chroma(q50))).to.equal(99);
        expect(q50.subarray(158).equals(rebuiltAt288x176.subarray(158))).to.equal(true);
        expect(q50.subarray(0, 25).equals(rebuiltAt288x176.subarray(0, 25))).to.equal(true);
        expect(Math.max(...luma(withQuality(rebuiltAt288x176, 1))), 'capped at 255').to.equal(255);
        expect(Math.min(...luma(withQuality(rebuiltAt288x176, 100))), 'at least 1').to.equal(1);
    });

    it('should leave a picture alone whose header is not the client header', () => {
        const ordinary = jpegJs.encode({ data: Buffer.alloc(16 * 16 * 4), width: 16, height: 16 }).data;
        expect(withQuality(ordinary, 30)).to.equal(ordinary);
        expect(withQuality(rebuiltAt288x176.subarray(0, 120), 30), 'cut in the second table').to.deep.equal(
            rebuiltAt288x176.subarray(0, 120),
        );
        expect(withQuality(Buffer.alloc(0), 30).length).to.equal(0);
    });

    it('should reject a quality outside 1..100', () => {
        for (const quality of [0, 101, -5, NaN]) {
            expect(withQuality(rebuiltAt288x176, quality), `quality ${quality}`).to.equal(rebuiltAt288x176);
        }
    });
});

describe('picture => redecodeV2Picture contrast', function () {
    this.timeout(30000);

    it('should put in the tables of the quality a picture was encoded with', async () => {
        const rebuilt = await redecodeV2Picture(buildV2Picture(400, 304, 30).rebuiltAt288x176);
        // Luma DC value of quality 35 is 23, of quality 25 it is 32; quality 30 has 27.
        expect(rebuilt![25]).to.be.within(23, 32);
        // The darkest values of the fixture are about 38; with the quality 85 tables they read about 110.
        const darkest = (jpeg: Buffer): number => jpegJs.decode(jpeg).data.reduce((low, v) => Math.min(low, v), 255);
        expect(darkest(rebuilt!)).to.be.below(60);
        expect(darkest(withQuality(rebuilt!, 85)), 'without the estimate').to.be.above(90);
    });

    it('should keep the tables of a picture encoded with quality 85', async () => {
        const { rebuiltAt288x176 } = buildV2Picture(400, 304);
        const rebuilt = await redecodeV2Picture(rebuiltAt288x176);
        expect(rebuilt!.subarray(25, 158).equals(rebuiltAt288x176.subarray(25, 158))).to.equal(true);
    });
});
