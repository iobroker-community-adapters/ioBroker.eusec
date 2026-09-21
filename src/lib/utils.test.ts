import { expect } from 'chai';

import type { ioBrokerLogger } from './log';
import {
    commonChanged,
    compareVersions,
    deleteEmptyUnknownChannels,
    handleUpdate,
    setPropertyState,
    setStateChangedAsync,
} from './utils';

const silentLog = { error: () => {} } as unknown as ioBrokerLogger;

describe('utils => compareVersions', () => {
    it('should compare parts as numbers, not as decimal fractions', () => {
        // The former parseFloat("3.100") made 3.10.0 older than 3.9.0.
        expect(compareVersions('3.10.0', '3.9.0')).to.be.greaterThan(0);
        expect(compareVersions('3.9.0', '3.10.0')).to.be.lessThan(0);
    });

    it('should treat equal versions as equal', () => {
        expect(compareVersions('3.2.1', '3.2.1')).to.equal(0);
    });

    it('should count a missing part as 0', () => {
        expect(compareVersions('1.0', '1.0.0')).to.equal(0);
        expect(compareVersions('1', '1.0.1')).to.be.lessThan(0);
    });

    it('should ignore a pre-release suffix', () => {
        expect(compareVersions('3.3.0-alpha.0', '3.3.0')).to.equal(0);
    });

    it('should read an unparsable part as 0', () => {
        expect(compareVersions('x.y.z', '0.0.0')).to.equal(0);
        expect(compareVersions('', '0.0.1')).to.be.lessThan(0);
    });
});

describe('utils => commonChanged', () => {
    const wanted = { name: 'Battery', type: 'number', role: 'value.battery', unit: '%', min: undefined };

    it('should not report a change for keys the database drops because they are undefined', () => {
        expect(commonChanged({ name: 'Battery', type: 'number', role: 'value.battery', unit: '%' }, wanted)).to.equal(
            false,
        );
    });

    it('should drop undefined values in nested objects too', () => {
        expect(commonChanged({ states: { 0: 'Off' } }, { states: { 0: 'Off', 1: undefined } })).to.equal(false);
    });

    it('should ignore the parts js-controller preserves', () => {
        const stored = { ...wanted, custom: { 'history.0': { enabled: true } }, smartName: 'Akku' };
        expect(commonChanged(stored, wanted)).to.equal(false);
    });

    it('should report a changed value', () => {
        expect(commonChanged({ ...wanted, unit: 'V' }, wanted)).to.equal(true);
    });

    it('should report a key that is no longer wanted', () => {
        expect(
            commonChanged({ name: 'Battery', type: 'number', role: 'value.battery', unit: '%', max: 100 }, wanted),
        ).to.equal(true);
    });
});

/** A fake adapter that knows a set of objects and records the state writes. */
const fakeAdapter = (
    objects: Record<string, ioBroker.Object>,
    setStateChanged: (id: string, state: unknown) => Promise<unknown> = () => Promise.resolve({}),
): {
    adapter: ioBroker.Adapter;
    writes: [string, unknown][];
    extended: [string, unknown][];
    created: [string, unknown][];
    deleted: string[];
} => {
    const writes: [string, unknown][] = [];
    const extended: [string, unknown][] = [];
    const created: [string, unknown][] = [];
    const deleted: string[] = [];
    const adapter = {
        getObjectAsync: (id: string) => Promise.resolve(objects[id] ?? null),
        getAdapterObjectsAsync: () => Promise.resolve(objects),
        getStatesAsync: () => Promise.resolve({}),
        getChannelsOfAsync: () => Promise.resolve([]),
        getDevicesAsync: () => Promise.resolve([]),
        setObjectAsync: (id: string, obj: unknown) => {
            created.push([id, obj]);
            return Promise.resolve({ id });
        },
        delObjectAsync: (id: string) => {
            deleted.push(id);
            return Promise.resolve();
        },
        extendObjectAsync: (id: string, obj: unknown) => {
            extended.push([id, obj]);
            return Promise.resolve({ id });
        },
        setStateChangedAsync: async (id: string, state: unknown) => {
            writes.push([id, state]);
            return setStateChanged(id, state);
        },
    } as unknown as ioBroker.Adapter;
    return { adapter, writes, extended, created, deleted };
};

const stateObject = (name: string, type: ioBroker.CommonType, commonName = name): ioBroker.Object =>
    ({ type: 'state', common: { name: commonName, type }, native: { name } }) as unknown as ioBroker.Object;

describe('utils => setStateChangedAsync', () => {
    it('should swallow a failed write instead of rejecting', async () => {
        const { adapter } = fakeAdapter({}, () => Promise.reject(new Error('DB closed')));
        await setStateChangedAsync(adapter, 'eusec.0.x', 1);
    });

    it('should clear the state for null and undefined', async () => {
        const { adapter, writes } = fakeAdapter({});
        await setStateChangedAsync(adapter, 'a', undefined);
        await setStateChangedAsync(adapter, 'b', null);
        expect(writes).to.deep.equal([
            ['a', null],
            ['b', null],
        ]);
    });
});

describe('utils => setPropertyState', () => {
    const id = 'eusec.0.T1.cameras.T2.battery';

    it('should write a state that has no value yet', async () => {
        // The former lookup only saw states with a value, so this update was dropped.
        const { adapter, writes } = fakeAdapter({ [id]: stateObject('battery', 'number') });
        expect(await setPropertyState(adapter, id, 'battery', 80)).to.equal(true);
        expect(writes).to.deep.equal([[id, { val: 80, ack: true }]]);
    });

    it('should write an object value as JSON to a string state', async () => {
        const { adapter, writes } = fakeAdapter({ [id]: stateObject('battery', 'string') });
        await setPropertyState(adapter, id, 'battery', { a: 1 });
        expect(writes).to.deep.equal([[id, { val: '{"a":1}', ack: true }]]);
    });

    it('should report a property without state', async () => {
        const { adapter, writes } = fakeAdapter({});
        expect(await setPropertyState(adapter, id, 'battery', 80)).to.equal(false);
        expect(writes).to.deep.equal([]);
    });

    it('should not write a state that belongs to another property', async () => {
        const { adapter, writes } = fakeAdapter({ [id]: stateObject('batteryTemp', 'number') });
        expect(await setPropertyState(adapter, id, 'battery', 80)).to.equal(false);
        expect(writes).to.deep.equal([]);
    });

    it('should not write a state without native name', async () => {
        const { adapter } = fakeAdapter({
            [id]: { type: 'state', common: { type: 'string' }, native: {} } as unknown as ioBroker.Object,
        });
        expect(await setPropertyState(adapter, id, 'battery', 80)).to.equal(false);
    });
});

describe('utils => handleUpdate', () => {
    const privacy = 'eusec.0.T1.cameras.T2.set_privacy_angle';
    const objects = (name: string): Record<string, ioBroker.Object> => ({
        [privacy]: stateObject('', 'boolean', name),
        'eusec.0.T1.cameras.T2.set_default_angle': stateObject('', 'boolean', 'Set Default Angle'),
    });

    it('should correct the name of set_privacy_angle when updating from 3.2.1', async () => {
        const { adapter, extended } = fakeAdapter(objects('Set Default Angle'));
        await handleUpdate(adapter, silentLog, '3.2.1');
        expect(extended).to.deep.equal([[privacy, { common: { name: 'Set Privacy Angle' } }]]);
    });

    it('should leave a name the user changed', async () => {
        const { adapter, extended } = fakeAdapter(objects('Kamera wegdrehen'));
        await handleUpdate(adapter, silentLog, '3.2.0');
        expect(extended).to.deep.equal([]);
    });

    it('should not migrate when updating from a newer version', async () => {
        const { adapter, extended } = fakeAdapter(objects('Set Default Angle'));
        await handleUpdate(adapter, silentLog, '3.10.0');
        expect(extended).to.deep.equal([]);
    });

    it('should not migrate a fresh installation', async () => {
        const { adapter, extended } = fakeAdapter(objects('Set Default Angle'));
        await handleUpdate(adapter, silentLog, '');
        expect(extended).to.deep.equal([]);
    });
});

describe('utils => handleUpdate titl_down', () => {
    const old = 'eusec.0.T1.cameras.T2.titl_down';
    const renamed = 'eusec.0.T1.cameras.T2.tilt_down';
    const button = {
        _id: old,
        type: 'state',
        common: {
            name: 'Nach unten',
            type: 'boolean',
            role: 'button.start',
            custom: { 'history.0': { enabled: true } },
        },
        native: {},
    } as unknown as ioBroker.Object;

    it('should move the object to tilt_down with name and custom settings', async () => {
        const { adapter, created, deleted } = fakeAdapter({ [old]: button });
        await handleUpdate(adapter, silentLog, '3.2.1');
        expect(created).to.deep.equal([[renamed, { ...button, _id: renamed }]]);
        expect(deleted).to.deep.equal([old]);
    });

    it('should only delete the old object when tilt_down exists already', async () => {
        const existing = { ...button, _id: renamed } as ioBroker.Object;
        const { adapter, created, deleted } = fakeAdapter({ [old]: button, [renamed]: existing });
        await handleUpdate(adapter, silentLog, '3.2.1');
        expect(created).to.deep.equal([]);
        expect(deleted).to.deep.equal([old]);
    });

    it('should not touch an id that only contains titl_down', async () => {
        const { adapter, created, deleted } = fakeAdapter({ 'eusec.0.T1.cameras.T2.titl_down_x': button });
        await handleUpdate(adapter, silentLog, '3.2.1');
        expect(created).to.deep.equal([]);
        expect(deleted).to.deep.equal([]);
    });

    it('should not migrate when updating from a newer version', async () => {
        const { adapter, deleted } = fakeAdapter({ [old]: button });
        await handleUpdate(adapter, silentLog, '3.3.0');
        expect(deleted).to.deep.equal([]);
    });
});

describe('utils => deleteEmptyUnknownChannels', () => {
    const channel = (name: string): ioBroker.Object =>
        ({ type: 'channel', common: { name }, native: {} }) as unknown as ioBroker.Object;

    it('should keep an unknown channel whose state has no value', async () => {
        // The former check looked for states with a value and deleted such a channel.
        const { adapter, deleted } = fakeAdapter({
            'eusec.0.T1.unknown': channel('unknown'),
            'eusec.0.T1.unknown.T2': stateObject('name', 'string'),
        });
        await deleteEmptyUnknownChannels(adapter);
        expect(deleted).to.deep.equal([]);
    });

    it('should delete an empty unknown channel', async () => {
        const { adapter, deleted } = fakeAdapter({
            'eusec.0.T1.unknown': channel('unknown'),
            'eusec.0.T1.unknownx.T2': stateObject('name', 'string'),
        });
        await deleteEmptyUnknownChannels(adapter);
        expect(deleted).to.deep.equal(['eusec.0.T1.unknown']);
    });

    it('should keep an empty channel with another name', async () => {
        const { adapter, deleted } = fakeAdapter({ 'eusec.0.T1.cameras': channel('cameras') });
        await deleteEmptyUnknownChannels(adapter);
        expect(deleted).to.deep.equal([]);
    });

    it('should do nothing without objects', async () => {
        const { adapter, deleted } = fakeAdapter({});
        await deleteEmptyUnknownChannels(adapter);
        expect(deleted).to.deep.equal([]);
    });
});
