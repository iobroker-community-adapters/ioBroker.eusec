/**
 * Commands sent to the instance over sendTo(). Kept out of main.ts so they can be tested without a
 * running js-controller.
 */

import { CommandName, DeviceNotFoundError, StationNotFoundError } from 'eufy-security-client';
import type { EufySecurity } from 'eufy-security-client';

/** The answer handed back to the sender. */
export interface MessageResponse {
    /** Same as sent, kept because of back compatibility. */
    sended: boolean;
    sent: boolean;
    result: unknown;
}

/** The part of EufySecurity the commands use. */
export type MessageTarget = Pick<EufySecurity, 'getStation' | 'getDevice' | 'getApi' | 'refreshCloudData'>;

const response = (sent: boolean, result: unknown): MessageResponse => ({ sended: sent, sent, result });

const isSerial = (value: unknown): value is string => typeof value === 'string' && value !== '';

const isOptional = (value: unknown, type: 'boolean' | 'number'): boolean =>
    value === undefined || typeof value === type;

/**
 * Runs a command received over sendTo().
 *
 * @param eufy The EufySecurity instance
 * @param command The command name
 * @param message The payload of the message
 * @param log The adapter log
 * @returns The answer for the sender
 */
export const handleMessage = async (
    eufy: MessageTarget,
    command: string,
    message: unknown,
    log: Pick<ioBroker.Logger, 'debug' | 'warn' | 'error'>,
): Promise<MessageResponse> => {
    const payload = (typeof message === 'object' && message !== null ? message : {}) as Record<string, unknown>;
    const missingParameters = response(
        false,
        `${command} command not sent because some required parameters are missing`,
    );
    try {
        switch (command) {
            case 'quickResponse': {
                log.debug(`quickResponse command - message: ${JSON.stringify(message)}`);
                if (
                    !isSerial(payload.station_sn) ||
                    !isSerial(payload.device_sn) ||
                    typeof payload.voice_id !== 'number'
                ) {
                    return missingParameters;
                }
                const station = await eufy.getStation(payload.station_sn);
                const device = await eufy.getDevice(payload.device_sn);
                if (!device.hasCommand(CommandName.DeviceQuickResponse)) {
                    return response(false, 'quickResponse command not supported by specified device');
                }
                station.quickResponse(device, payload.voice_id);
                return response(true, 'quickResponse command sent');
            }
            case 'getQuickResponseVoices': {
                log.debug(`getQuickResponseVoices command - message: ${JSON.stringify(message)}`);
                if (!isSerial(payload.device_sn)) {
                    return missingParameters;
                }
                return response(true, await eufy.getApi().getVoices(payload.device_sn));
            }
            case 'snooze': {
                log.debug(`snooze command - message: ${JSON.stringify(message)}`);
                if (
                    !isSerial(payload.station_sn) ||
                    !isSerial(payload.device_sn) ||
                    typeof payload.snooze_time !== 'number' ||
                    !isOptional(payload.snooze_chime, 'boolean') ||
                    !isOptional(payload.snooze_homebase, 'boolean') ||
                    !isOptional(payload.snooze_motion, 'boolean')
                ) {
                    return missingParameters;
                }
                const station = await eufy.getStation(payload.station_sn);
                const device = await eufy.getDevice(payload.device_sn);
                if (!device.hasCommand(CommandName.DeviceSnooze)) {
                    return response(false, 'snooze command not supported by specified device');
                }
                station.snooze(device, {
                    snooze_time: payload.snooze_time,
                    snooze_chime: payload.snooze_chime as boolean | undefined,
                    snooze_homebase: payload.snooze_homebase as boolean | undefined,
                    snooze_motion: payload.snooze_motion as boolean | undefined,
                });
                return response(true, 'snooze command sent');
            }
            case 'chime': {
                log.debug(`chime command - message: ${JSON.stringify(message)}`);
                if (!isSerial(payload.station_sn) || !isOptional(payload.ringtone, 'number')) {
                    return missingParameters;
                }
                const station = await eufy.getStation(payload.station_sn);
                if (!station.hasCommand(CommandName.StationChime)) {
                    return response(false, 'chime command not supported by specified station');
                }
                station.chimeHomebase((payload.ringtone as number | undefined) ?? 0);
                return response(true, 'chime command sent');
            }
            case 'pollRefresh': {
                log.debug(`pollRefresh command`);
                await eufy.refreshCloudData();
                return response(true, 'pollRefresh command sent');
            }
            default: {
                const errorMessage = `Received unknown message: ${JSON.stringify(message)}`;
                log.warn(errorMessage);
                return response(false, errorMessage);
            }
        }
    } catch (error) {
        if (error instanceof StationNotFoundError) {
            return response(false, `${command} command not sent because specified station doesn't exists`);
        }
        if (error instanceof DeviceNotFoundError) {
            return response(false, `${command} command not sent because specified device doesn't exists`);
        }
        const errorMessage = `Error during processing of received message: ${error instanceof Error ? `${error.name} - ${error.message}` : String(error)}`;
        log.error(errorMessage);
        return response(false, errorMessage);
    }
};
