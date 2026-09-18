import { expect } from 'chai';
import type { Picture } from 'eufy-security-client';

import { getPictureExtension } from './picture';

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
