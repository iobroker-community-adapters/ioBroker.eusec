import { expect } from 'chai';
import { CommandName, PropertyName, type Picture, type PropertyValue } from 'eufy-security-client';

import { describePictureData, getPictureExtension, schedulePictureOverP2P } from './picture';

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
