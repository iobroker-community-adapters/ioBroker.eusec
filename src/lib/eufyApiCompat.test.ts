import { expect } from 'chai';
import crypto from 'node:crypto';
import path from 'node:path';
import { HTTPApi, MegaHTTPApi } from 'eufy-security-client';
import type { DeviceListResponse, MegaResult, StationListResponse } from 'eufy-security-client';

import {
    applyEufyApiCompatibility,
    eufyClientOptions,
    isIdentityRejected,
    describeSubstitutedDevice,
    normalizeSuccessCode,
    substituteDeviceTypes,
} from './eufyApiCompat';

describe('eufyApiCompat => substituteDeviceTypes', () => {
    it('should give the eufyCam C31 the type of the SoloCam Spotlight 1080', () => {
        const list = [{ device_sn: 'T817L', device_type: 10031, params: [] }];
        expect(substituteDeviceTypes(list)).to.deep.equal([{ type: 10031, entry: list[0] }]);
        expect(list[0]).to.deep.equal({ device_sn: 'T817L', device_type: 60, params: [] });
    });

    it('should leave known and other unknown types untouched', () => {
        const list = [{ device_type: 60 }, { device_type: 10030 }, { device_type: 0 }, { device_type: -1 }];
        expect(substituteDeviceTypes(list)).to.deep.equal([]);
        expect(list.map(entry => entry.device_type)).to.deep.equal([60, 10030, 0, -1]);
    });

    it('should not treat a type sent as a string as a number', () => {
        const list = [{ device_type: '10031' }];
        expect(substituteDeviceTypes(list)).to.deep.equal([]);
        expect(list[0].device_type).to.equal('10031');
    });

    it('should skip broken entries and ignore values that are not lists', () => {
        expect(substituteDeviceTypes([null, undefined, 'x', {}, { device_type: 10031 }])).to.deep.equal([
            { type: 10031, entry: { device_type: 60 } },
        ]);
        expect(substituteDeviceTypes(undefined)).to.deep.equal([]);
        expect(substituteDeviceTypes(null)).to.deep.equal([]);
        expect(substituteDeviceTypes({ device_type: 10031 })).to.deep.equal([]);
        expect(substituteDeviceTypes([])).to.deep.equal([]);
    });
});

describe('eufyApiCompat => describeSubstitutedDevice', () => {
    it('should name the device and carry its raw params', () => {
        const line = describeSubstitutedDevice({
            type: 10031,
            entry: {
                device_name: 'Einfahrt',
                device_model: 'T817L',
                main_sw_version: '1.0.4',
                main_hw_version: 'P1',
                params: [{ param_type: 1011, param_value: '1' }],
            },
        });
        expect(line).to.include('Einfahrt (type 10031, model T817L, firmware 1.0.4, hardware P1)');
        expect(line).to.include('#156');
        expect(line).to.include('[{"param_type":1011,"param_value":"1"}]');
    });

    it('should not throw on an entry without any fields', () => {
        expect(describeSubstitutedDevice({ type: 10031, entry: {} })).to.include(
            'undefined (type 10031, model undefined',
        );
    });
});

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
        HTTPApi.prototype.getDeviceList = function (): Promise<DeviceListResponse[]> {
            return Promise.resolve([
                { device_sn: 'T8170', device_type: 10031, params: [] },
                { device_sn: 'T8000', device_type: 1, params: [] },
            ] as unknown as DeviceListResponse[]);
        };
        HTTPApi.prototype.getStationList = function (): Promise<StationListResponse[]> {
            return Promise.resolve([{ device_type: 10031 }] as StationListResponse[]);
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

    it('should substitute unknown device types in the device and the station list', async () => {
        expect((await api.getDeviceList()).map(device => device.device_type)).to.deep.equal([60, 1]);
        expect((await api.getStationList()).map(station => station.device_type)).to.deep.equal([60]);
        await api.getDeviceList();
        expect(messages.filter(message => message.includes('Device type 10031')).length, 'logged once').to.equal(1);
        expect(messages.filter(message => message.startsWith('Parameters of')).length, 'once per device').to.equal(1);
    });
});

describe('eufyApiCompat => eufyClientOptions', () => {
    // The P2P key helpers are not exported by the package, so they are loaded from its build.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const p2pUtils = require(path.join(path.dirname(require.resolve('eufy-security-client')), 'p2p', 'utils.js')) as {
        getNewRSAPrivateKey: (embedded?: boolean) => {
            encrypt: (data: Buffer) => Buffer;
            decrypt: (data: Buffer) => Buffer;
            exportKey: (format: string) => string;
        };
        getRSAPrivateKey: (pem: string, embedded?: boolean) => { decrypt: (data: Buffer) => Buffer };
    };
    const aesKey = Buffer.from('0123456789abcdef');
    const originalPrivateDecrypt = crypto.privateDecrypt;

    // Simulates a node.js build that refuses PKCS#1 v1.5 private decryption (CVE-2023-46809),
    // with the error text reported in iobroker-community-adapters/ioBroker.eusec#144.
    beforeEach(() => {
        (crypto as { privateDecrypt: unknown }).privateDecrypt = (
            options: { padding?: number },
            buffer: Buffer,
        ): Buffer => {
            if (options.padding === crypto.constants.RSA_PKCS1_PADDING) {
                throw new TypeError('RSA_PKCS1_PADDING is no longer supported for private decryption');
            }
            return originalPrivateDecrypt(options as crypto.RsaPrivateKey, buffer);
        };
    });

    afterEach(() => {
        (crypto as { privateDecrypt: unknown }).privateDecrypt = originalPrivateDecrypt;
    });

    it('should reproduce the failure without the embedded PKCS#1 implementation', () => {
        const key = p2pUtils.getNewRSAPrivateKey(false);
        expect(() => key.decrypt(key.encrypt(aesKey))).to.throw(/RSA_PKCS1_PADDING/);
    });

    it('should decrypt a P2P stream key on such a node.js build', () => {
        const key = p2pUtils.getNewRSAPrivateKey(eufyClientOptions.enableEmbeddedPKCS1Support);
        expect(key.decrypt(key.encrypt(aesKey))).to.deep.equal(aesKey);
    });

    it('should decrypt with a station key imported from the cloud', () => {
        const station = p2pUtils.getNewRSAPrivateKey(true);
        const imported = p2pUtils.getRSAPrivateKey(
            station.exportKey('pkcs8-private-pem'),
            eufyClientOptions.enableEmbeddedPKCS1Support,
        );
        expect(imported.decrypt(station.encrypt(aesKey))).to.deep.equal(aesKey);
    });

    it('should decrypt a key of the minimum and maximum length PKCS#1 v1.5 allows', () => {
        const key = p2pUtils.getNewRSAPrivateKey(eufyClientOptions.enableEmbeddedPKCS1Support);
        // A 1024 bit key carries at most 128 - 11 bytes of payload.
        for (const payload of [Buffer.alloc(1, 0x42), Buffer.alloc(117, 0x42)]) {
            expect(key.decrypt(key.encrypt(payload))).to.deep.equal(payload);
        }
    });

    it('should report a corrupted key instead of returning garbage', () => {
        const key = p2pUtils.getNewRSAPrivateKey(eufyClientOptions.enableEmbeddedPKCS1Support);
        const encrypted = key.encrypt(aesKey);
        encrypted[0] ^= 0xff;
        expect(() => key.decrypt(encrypted)).to.throw();
    });
});
