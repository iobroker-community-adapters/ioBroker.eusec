import { expect } from 'chai';

import { normalizeSuccessCode } from './eufyApiCompat';

describe('eufyApiCompat => normalizeSuccessCode', () => {
    it('should rewrite the HTTP style success code to the legacy one', () => {
        const body = { code: 200, msg: '' };
        expect(normalizeSuccessCode(body)).to.equal(true);
        expect(body.code).to.equal(0);
    });

    it('should leave the legacy success code untouched', () => {
        const body = { code: 0, msg: '' };
        expect(normalizeSuccessCode(body)).to.equal(false);
        expect(body.code).to.equal(0);
    });

    it('should leave error codes untouched', () => {
        const body = { code: 26052, msg: 'need verify code' };
        expect(normalizeSuccessCode(body)).to.equal(false);
        expect(body.code).to.equal(26052);
    });

    it('should pass the encrypted payload through untouched', () => {
        const body = { code: 200, data: 'encrypted-payload' };
        normalizeSuccessCode(body);
        expect(body.data).to.equal('encrypted-payload');
    });

    it('should ignore bodies that are not objects', () => {
        expect(normalizeSuccessCode(undefined)).to.equal(false);
        expect(normalizeSuccessCode(null)).to.equal(false);
        expect(normalizeSuccessCode('EOF')).to.equal(false);
    });
});
