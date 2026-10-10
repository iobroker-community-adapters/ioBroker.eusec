import { expect } from 'chai';
import crypto from 'node:crypto';
import path from 'node:path';
import {
    CommandType,
    Device,
    DeviceType,
    HTTPApi,
    MegaHTTPApi,
    P2PClientProtocol,
    ParamType,
    PresetPositionType,
    Station,
} from 'eufy-security-client';
import type { DeviceListResponse, MegaResult, StationListResponse } from 'eufy-security-client';

import {
    applyEufyApiCompatibility,
    eufyClientOptions,
    isIdentityRejected,
    describeSubstitutedDevice,
    keepStationsConnected,
    normalizeSuccessCode,
    parseSerialList,
    substituteDeviceTypes,
} from './eufyApiCompat';

describe('eufyApiCompat => parseSerialList', () => {
    it('should trim, upper case and deduplicate the serial numbers of an array', () => {
        expect(parseSerialList([' t8113n1234 ', 'T8113N1234', 'T8210P5678'])).to.deep.equal([
            'T8113N1234',
            'T8210P5678',
        ]);
    });

    it('should accept a comma separated string', () => {
        expect(parseSerialList('T8113N1234, t8210p5678,,')).to.deep.equal(['T8113N1234', 'T8210P5678']);
    });

    it('should drop empty entries and entries that are not strings', () => {
        expect(parseSerialList(['', '   ', 42, null, undefined, {}, ['T1'], 'T2'])).to.deep.equal(['T2']);
    });

    it('should return an empty list for a missing or malformed setting', () => {
        expect(parseSerialList(undefined)).to.deep.equal([]);
        expect(parseSerialList(null)).to.deep.equal([]);
        expect(parseSerialList('')).to.deep.equal([]);
        expect(parseSerialList(42)).to.deep.equal([]);
        expect(parseSerialList({ 0: 'T1' })).to.deep.equal([]);
        expect(parseSerialList([])).to.deep.equal([]);
    });
});

describe('eufyApiCompat => substituteDeviceTypes', () => {
    it('should give the eufyCam C31 the type of the SoloCam Spotlight 1080', () => {
        const list = [{ device_sn: 'T817L', device_type: 10031, params: [] }];
        expect(substituteDeviceTypes(list)).to.deep.equal([{ type: 10031, entry: list[0] }]);
        expect(list[0]).to.deep.equal({ device_sn: 'T817L', device_type: 60, params: [] });
    });

    it('should give the eufyCam C37 the type of the eufyCam S4', () => {
        const list = [{ device_sn: 'T814X', device_type: 10037, params: [] }];
        expect(substituteDeviceTypes(list)).to.deep.equal([{ type: 10037, entry: list[0] }]);
        expect(list[0]).to.deep.equal({ device_sn: 'T814X', device_type: 89, params: [] });
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

    it('should point a C37 to its own issue', () => {
        const line = describeSubstitutedDevice({ type: 10037, entry: { device_model: 'T814X' } });
        expect(line).to.include('(type 10037, model T814X');
        expect(line).to.include('#198');
        expect(line).not.to.include('#156');
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
                { device_sn: 'T8140', device_type: 10037, params: [] },
            ] as unknown as DeviceListResponse[]);
        };
        HTTPApi.prototype.getStationList = function (): Promise<StationListResponse[]> {
            return Promise.resolve([{ device_type: 10031 }] as StationListResponse[]);
        };
        // Stands in for the library: a station list entry with a battery makes it an energy saving device.
        P2PClientProtocol.prototype.updateRawStation = function (value: StationListResponse): void {
            (this as unknown as { energySavingDevice: boolean }).energySavingDevice = (
                value as unknown as { battery: boolean }
            ).battery;
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
        expect((await api.getDeviceList()).map(device => device.device_type)).to.deep.equal([60, 1, 89]);
        expect((await api.getStationList()).map(station => station.device_type)).to.deep.equal([60]);
        await api.getDeviceList();
        expect(messages.filter(message => message.includes('Device type 10031')).length, 'logged once').to.equal(1);
        expect(messages.filter(message => message.includes('Device type 10037')).length, 'logged once').to.equal(1);
        expect(messages.find(message => message.includes('Device type 10037'))).to.include('type 89 - see #198');
        expect(messages.filter(message => message.startsWith('Parameters of')).length, 'once per device').to.equal(2);
    });

    describe('kept P2P connection', () => {
        const update = (serial: unknown, battery: boolean): boolean => {
            const session = Object.create(P2PClientProtocol.prototype) as P2PClientProtocol;
            session.updateRawStation({ station_sn: serial, battery } as unknown as StationListResponse);
            return session.isEnergySavingDevice();
        };
        const keptMessages = (serial: string): number =>
            messages.filter(message => message.startsWith(`Station ${serial} is a battery device`)).length;

        afterEach(() => keepStationsConnected([]));

        it('should keep a configured battery device connected and say so once', () => {
            keepStationsConnected(['T8113N1234']);
            expect(update('T8113N1234', true)).to.equal(false);
            expect(update('T8113N1234', true), 'after every station list refresh').to.equal(false);
            expect(keptMessages('T8113N1234')).to.equal(1);
        });

        it('should leave battery devices that are not configured alone', () => {
            keepStationsConnected(['T8113N1234']);
            expect(update('T8210P5678', true)).to.equal(true);
            expect(keptMessages('T8210P5678')).to.equal(0);
        });

        it('should not report a configured device that is not an energy saving device', () => {
            keepStationsConnected(['T8030P0000']);
            expect(update('T8030P0000', false)).to.equal(false);
            expect(keptMessages('T8030P0000')).to.equal(0);
        });

        it('should replace the list instead of adding to it', () => {
            keepStationsConnected(['T8113N1234']);
            keepStationsConnected(['T8210P5678']);
            expect(update('T8113N1234', true)).to.equal(true);
            expect(update('T8210P5678', true)).to.equal(false);
        });

        it('should survive a station list entry without a serial number', () => {
            keepStationsConnected(['T8113N1234']);
            expect(update(undefined, true)).to.equal(true);
        });
    });

    describe('Floodlight Cam E30', () => {
        const serial = 'T8426P0000000000';
        const sent: { commandType: number; value: string }[] = [];
        // Both constructors need a live session. The commands only read the fields given here, most
        // of them private in the typings, so a bare instance carrying just those is enough.
        const bare = <T>(prototype: T, fields: object): T =>
            Object.assign(Object.create(prototype as object) as object, fields) as unknown as T;
        // A standalone floodlight is its own station. The P2P session records the payload instead of
        // sending it.
        const station = bare(Station.prototype, {
            rawStation: {
                station_sn: serial,
                device_type: DeviceType.FLOODLIGHT_CAMERA_8426,
                main_sw_version: '1.2.1.0',
                member: { admin_user_id: 'admin' },
            },
            p2pSession: {
                sendCommandWithStringPayload: (command: { commandType: number; value: string }): void => {
                    sent.push(command);
                },
                isLiveStreaming: (): boolean => false,
                getRSAPrivateKey: (): undefined => undefined,
            },
        });
        const device = (type: DeviceType): Device =>
            bare(Device.prototype, {
                rawDevice: { device_sn: serial, station_sn: serial, device_type: type, device_channel: 0 },
            });
        const lastPayload = (): { commandType: number; data: Record<string, unknown> } => {
            expect(sent, 'a command must reach the P2P session').to.have.length(1);
            expect(sent[0].commandType).to.equal(CommandType.CMD_DOORBELL_SET_PAYLOAD);
            return JSON.parse(sent[0].value) as { commandType: number; data: Record<string, unknown> };
        };
        const e30Messages = (): number => messages.filter(message => message.includes('(T8426)')).length;

        beforeEach(() => {
            sent.length = 0;
        });

        it('should classify the E30 as the E340 it is defined as, and no other type with it', () => {
            expect(Device.isFloodLightT8425(DeviceType.FLOODLIGHT_CAMERA_8426)).to.equal(true);
            expect(Device.isFloodLightT8425(DeviceType.FLOODLIGHT_CAMERA_8425)).to.equal(true);
            for (const type of [
                DeviceType.FLOODLIGHT,
                DeviceType.FLOODLIGHT_CAMERA_8422,
                DeviceType.FLOODLIGHT_CAMERA_8423,
                DeviceType.FLOODLIGHT_CAMERA_8424,
                DeviceType.SOLO_CAMERA_E30,
                10031,
                0,
                -1,
                NaN,
            ]) {
                expect(Device.isFloodLightT8425(type), `type ${type}`).to.equal(false);
            }
            expect(device(DeviceType.FLOODLIGHT_CAMERA_8426).isFloodLightT8425()).to.equal(true);
        });

        it('should send the preset commands to an E30', () => {
            const commands: [(device: Device, position: PresetPositionType) => void, CommandType][] = [
                [station.presetPosition, CommandType.CMD_FLOODLIGHT_SET_MOTION_PRESET_POSITION],
                [station.savePresetPosition, CommandType.CMD_FLOODLIGHT_SAVE_MOTION_PRESET_POSITION],
                [station.deletePresetPosition, CommandType.CMD_FLOODLIGHT_DELETE_MOTION_PRESET_POSITION],
            ];
            for (const [command, commandType] of commands) {
                for (const position of [PresetPositionType.PRESET_1, PresetPositionType.PRESET_4]) {
                    sent.length = 0;
                    command.call(station, device(DeviceType.FLOODLIGHT_CAMERA_8426), position);
                    expect(lastPayload()).to.deep.equal({ commandType, data: { value: position } });
                }
            }
        });

        it('should still reject a preset the camera does not have', () => {
            expect(() =>
                station.presetPosition(device(DeviceType.FLOODLIGHT_CAMERA_8426), 4 as PresetPositionType),
            ).to.throw('Invalid value for this command');
            expect(sent).to.have.length(0);
        });

        it('should start the livestream of an E30 with the payload of the E340', () => {
            station.startLivestream(device(DeviceType.FLOODLIGHT_CAMERA_8426));
            const { commandType, data } = lastPayload();
            expect(commandType).to.equal(ParamType.COMMAND_START_LIVESTREAM);
            // The E30 rejects the start without these with ERROR_INVALID_ACCOUNT (-104).
            expect(data).to.include({ accountId: 'admin', camera_type: 0, entrytype: 0 });
            expect(data).to.not.have.property('account_id');
        });

        it('should leave the livestream of an older floodlight on its own route', () => {
            station.startLivestream(device(DeviceType.FLOODLIGHT_CAMERA_8422));
            const { data } = lastPayload();
            expect(data).to.include({ account_id: 'admin' });
            expect(data).to.not.have.property('camera_type');
        });

        it('should say once that the E30 is handled like the E340', () => {
            expect(e30Messages()).to.equal(1);
        });
    });
});

describe('eufyApiCompat => eufyClientOptions', function () {
    // Every test generates a 1024 bit RSA key in JavaScript, which takes several seconds on a busy
    // machine - more than the 2 seconds mocha allows by default.
    this.timeout(20000);

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
