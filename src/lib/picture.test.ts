import { expect } from 'chai';
import type { Picture } from 'eufy-security-client';

import { describePictureData, getPictureExtension } from './picture';

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
