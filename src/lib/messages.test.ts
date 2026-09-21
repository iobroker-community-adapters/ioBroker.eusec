import { expect } from 'chai';
import { CommandName, DeviceNotFoundError, StationNotFoundError } from 'eufy-security-client';

import { handleMessage, type MessageTarget } from './messages';

interface Calls {
    chime: unknown[];
    quickResponse: unknown[];
    snooze: unknown[];
}

/** A fake EufySecurity with one station T1 and one device T2, supporting the given commands. */
const fakeEufy = (commands: CommandName[], calls: Calls): MessageTarget => {
    const station = {
        hasCommand: (command: CommandName) => commands.includes(command),
        chimeHomebase: (ringtone: number) => calls.chime.push(ringtone),
        quickResponse: (_device: unknown, voice: number) => calls.quickResponse.push(voice),
        snooze: (_device: unknown, options: unknown) => calls.snooze.push(options),
    };
    const device = { hasCommand: (command: CommandName) => commands.includes(command) };
    return {
        getStation: (serial: string) =>
            serial === 'T1'
                ? Promise.resolve(station)
                : Promise.reject(new StationNotFoundError("Station doesn't exists")),
        getDevice: (serial: string) =>
            serial === 'T2'
                ? Promise.resolve(device)
                : Promise.reject(new DeviceNotFoundError("Device doesn't exists")),
        getApi: () => ({ getVoices: () => Promise.resolve({ 1: 'Hello' }) }),
        refreshCloudData: async () => {},
    } as unknown as MessageTarget;
};

const run = async (
    command: string,
    message: unknown,
    commands: CommandName[] = [],
): Promise<{ result: Awaited<ReturnType<typeof handleMessage>>; calls: Calls; warnings: string[] }> => {
    const calls: Calls = { chime: [], quickResponse: [], snooze: [] };
    const warnings: string[] = [];
    const log = { debug: () => {}, warn: (line: string) => warnings.push(line), error: () => {} };
    const result = await handleMessage(fakeEufy(commands, calls), command, message, log);
    return { result, calls, warnings };
};

describe('messages => chime', () => {
    it('should answer once with "not supported" for a station without chime', async () => {
        // The former handler answered "not supported" and then "chime command sent" as well.
        const { result, calls } = await run('chime', { station_sn: 'T1' });
        expect(result).to.deep.equal({
            sended: false,
            sent: false,
            result: 'chime command not supported by specified station',
        });
        expect(calls.chime).to.deep.equal([]);
    });

    it('should chime with ringtone 0 when none is given', async () => {
        const { result, calls } = await run('chime', { station_sn: 'T1' }, [CommandName.StationChime]);
        expect(result.sent).to.equal(true);
        expect(calls.chime).to.deep.equal([0]);
    });

    it('should pass the given ringtone', async () => {
        const { calls } = await run('chime', { station_sn: 'T1', ringtone: 3 }, [CommandName.StationChime]);
        expect(calls.chime).to.deep.equal([3]);
    });

    it('should answer when parameters are missing or invalid', async () => {
        // The former handler did not answer at all, the sender waited for its timeout.
        for (const message of [{}, { station_sn: '' }, { station_sn: 'T1', ringtone: '3' }]) {
            const { result, calls } = await run('chime', message, [CommandName.StationChime]);
            expect(result).to.deep.equal({
                sended: false,
                sent: false,
                result: 'chime command not sent because some required parameters are missing',
            });
            expect(calls.chime).to.deep.equal([]);
        }
    });

    it('should name the chime command for an unknown station', async () => {
        const { result } = await run('chime', { station_sn: 'T9' }, [CommandName.StationChime]);
        expect(result.result).to.equal("chime command not sent because specified station doesn't exists");
    });
});

describe('messages => quickResponse', () => {
    const message = { station_sn: 'T1', device_sn: 'T2', voice_id: 7 };

    it('should send the quick response', async () => {
        const { result, calls } = await run('quickResponse', message, [CommandName.DeviceQuickResponse]);
        expect(result).to.deep.equal({ sended: true, sent: true, result: 'quickResponse command sent' });
        expect(calls.quickResponse).to.deep.equal([7]);
    });

    it('should refuse a device without quick response', async () => {
        const { result } = await run('quickResponse', message);
        expect(result.result).to.equal('quickResponse command not supported by specified device');
    });

    it('should refuse a voice id that is not a number', async () => {
        const { result } = await run('quickResponse', { ...message, voice_id: '7' }, [CommandName.DeviceQuickResponse]);
        expect(result.result).to.equal('quickResponse command not sent because some required parameters are missing');
    });

    it('should report an unknown device', async () => {
        const { result } = await run('quickResponse', { ...message, device_sn: 'T9' }, [
            CommandName.DeviceQuickResponse,
        ]);
        expect(result.result).to.equal("quickResponse command not sent because specified device doesn't exists");
    });
});

describe('messages => snooze', () => {
    const message = { station_sn: 'T1', device_sn: 'T2', snooze_time: 60 };

    it('should snooze with the optional flags', async () => {
        const { result, calls } = await run('snooze', { ...message, snooze_chime: true }, [CommandName.DeviceSnooze]);
        expect(result.sent).to.equal(true);
        expect(calls.snooze).to.deep.equal([
            { snooze_time: 60, snooze_chime: true, snooze_homebase: undefined, snooze_motion: undefined },
        ]);
    });

    it('should refuse an optional flag that is not a boolean', async () => {
        const { result, calls } = await run('snooze', { ...message, snooze_motion: 1 }, [CommandName.DeviceSnooze]);
        expect(result.sent).to.equal(false);
        expect(calls.snooze).to.deep.equal([]);
    });
});

describe('messages => other commands', () => {
    it('should return the voices', async () => {
        const { result } = await run('getQuickResponseVoices', { device_sn: 'T2' });
        expect(result).to.deep.equal({ sended: true, sent: true, result: { 1: 'Hello' } });
    });

    it('should refresh the cloud data', async () => {
        const { result } = await run('pollRefresh', {});
        expect(result.result).to.equal('pollRefresh command sent');
    });

    it('should warn about an unknown command', async () => {
        const { result, warnings } = await run('explode', { a: 1 });
        expect(result.sent).to.equal(false);
        expect(warnings).to.deep.equal(['Received unknown message: {"a":1}']);
    });

    it('should report an unexpected error', async () => {
        const calls: Calls = { chime: [], quickResponse: [], snooze: [] };
        const eufy = { ...fakeEufy([], calls), refreshCloudData: () => Promise.reject(new TypeError('offline')) };
        const log = { debug: () => {}, warn: () => {}, error: () => {} };
        const result = await handleMessage(eufy, 'pollRefresh', {}, log);
        expect(result.result).to.equal('Error during processing of received message: TypeError - offline');
    });
});
