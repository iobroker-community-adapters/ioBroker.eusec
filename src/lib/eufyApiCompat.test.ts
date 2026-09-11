import { expect } from 'chai';
import { HTTPApi, MegaHTTPApi } from 'eufy-security-client';
import type { MegaResult } from 'eufy-security-client';

import { applyEufyApiCompatibility, isIdentityRejected, normalizeSuccessCode } from './eufyApiCompat';

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

describe('eufyApiCompat => isIdentityRejected', () => {
    it('should recognise the codes the v6 backend rejects an identity with', () => {
        expect(isIdentityRejected({ code: 4404, msg: 'get identity error' })).to.equal(true);
        expect(isIdentityRejected({ code: 4416, msg: 'signature error' })).to.equal(true);
    });

    it('should leave every other answer alone', () => {
        expect(isIdentityRejected({ code: 0, msg: '' })).to.equal(false);
        expect(isIdentityRejected({ code: 26052, msg: 'need verify code' })).to.equal(false);
        expect(isIdentityRejected({ msg: 'no code at all' })).to.equal(false);
        expect(isIdentityRejected(undefined)).to.equal(false);
        expect(isIdentityRejected(null)).to.equal(false);
        expect(isIdentityRejected('4404')).to.equal(false);
    });
});

// applyEufyApiCompatibility() patches the prototypes exactly once per process, so the fakes have to
// be in place before it runs and all of it is exercised in a single, ordered describe block.
describe('eufyApiCompat => applyEufyApiCompatibility', () => {
    // Both constructors are private and take a prepared session, but the shims only ever touch the
    // prototypes - a bare instance is enough to call them through.
    const api = Object.create(HTTPApi.prototype) as HTTPApi;
    const mega = Object.create(MegaHTTPApi.prototype) as MegaHTTPApi;
    const messages: string[] = [];
    let pushTokenAccepted = false;
    let checkPushTokenCalls = 0;
    let callResults: MegaResult[] = [];
    let callArguments: unknown[][] = [];

    before(() => {
        HTTPApi.prototype.checkPushToken = function (): Promise<boolean> {
            checkPushTokenCalls++;
            return Promise.resolve(pushTokenAccepted);
        };
        MegaHTTPApi.prototype.call = function (host: string, path: string, payload: unknown): Promise<MegaResult> {
            callArguments.push([host, path, payload]);
            return Promise.resolve(callResults[callArguments.length - 1]);
        };
        applyEufyApiCompatibility(message => messages.push(message));
    });

    beforeEach(() => {
        callResults = [];
        callArguments = [];
    });

    it('should keep asking the legacy push endpoint while it accepts the token', async () => {
        pushTokenAccepted = true;
        expect(await api.checkPushToken()).to.equal(true);
        expect(await api.checkPushToken()).to.equal(true);
        expect(checkPushTokenCalls).to.equal(2);
    });

    it('should stop asking the legacy push endpoint after it rejected the account', async () => {
        pushTokenAccepted = false;
        expect(await api.checkPushToken()).to.equal(false);
        expect(checkPushTokenCalls).to.equal(3);

        expect(await api.checkPushToken()).to.equal(false);
        expect(checkPushTokenCalls, 'the endpoint must not be asked a second time').to.equal(3);
        expect(messages.some(message => message.includes('legacy push endpoint'))).to.equal(true);
    });

    it('should repeat a v6 call whose identity was rejected', async () => {
        callResults = [
            { code: 4404, msg: 'get identity error' },
            { code: 0, msg: '' },
        ];
        const result = await mega.call('host', '/app/push/register_push_token', { token: 'fcm' });
        expect(result.code).to.equal(0);
        expect(callArguments.length).to.equal(2);
        expect(callArguments[1]).to.deep.equal(['host', '/app/push/register_push_token', { token: 'fcm' }]);
    });

    it('should not repeat a v6 call that was answered', async () => {
        callResults = [{ code: 0, msg: '' }];
        const result = await mega.call('host', '/app/push/register_push_token', { token: 'fcm' });
        expect(result.code).to.equal(0);
        expect(callArguments.length).to.equal(1);
    });

    it('should give up after one repetition', async () => {
        callResults = [
            { code: 4404, msg: 'get identity error' },
            { code: 4404, msg: 'get identity error' },
        ];
        const result = await mega.call('host', '/app/push/register_push_token', { token: 'fcm' });
        expect(result.code).to.equal(4404);
        expect(callArguments.length).to.equal(2);
    });
});
