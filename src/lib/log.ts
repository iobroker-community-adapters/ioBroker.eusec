import type { Logger } from 'ts-log';

/**
 * Serializes the extra parameters of a log call. Plain JSON.stringify() turns an Error into `{}`,
 * which hid the message of every `logger.error('...', error)`, and throws on a circular structure
 * (a got HTTPError is one), which made the log call itself fail inside a catch block.
 *
 * Known limit: an object that is referenced twice without a cycle is also printed as
 * `[Circular]` the second time. Tracking the ancestor chain instead would fix that.
 *
 * @param params The optional parameters of a log call
 * @returns The parameters as JSON, errors with name, message and their own properties
 */
export const formatLogParams = (params: unknown[]): string => {
    const seen = new WeakSet<object>();
    return JSON.stringify(params, (_key, value: unknown) => {
        if (typeof value === 'bigint') {
            return value.toString();
        }
        if (value === null || typeof value !== 'object') {
            return value;
        }
        if (seen.has(value)) {
            return '[Circular]';
        }
        seen.add(value);
        if (value instanceof Error) {
            return {
                ...value,
                name: value.name,
                message: value.message,
                ...(value.cause !== undefined ? { cause: value.cause } : {}),
            };
        }
        return value;
    });
};

export class ioBrokerLogger implements Logger {
    private readonly log: ioBroker.Logger;

    public constructor(log: ioBroker.Logger) {
        this.log = log;
    }

    private _getStack(): any {
        const _prepareStackTrace = Error.prepareStackTrace;
        Error.prepareStackTrace = (_, stack) => stack;
        const stack = new Error().stack?.slice(3);
        Error.prepareStackTrace = _prepareStackTrace;
        return stack;
    }

    private _getMessage(message?: string, hideTag = false, optionalParams?: any[]): string {
        const msg = message ? message : '';
        const stack = this._getStack();
        const typeName = stack[0].getTypeName() !== null ? stack[0].getTypeName() : '';
        const functionName = stack[0].getFunctionName() !== null ? `${stack[0].getFunctionName()}` : '';
        let tag = '';
        if (typeName !== '' && !hideTag) {
            tag = `[${typeName}`;
            if (functionName !== '') {
                tag = `${tag}.${functionName}] `;
            } else {
                tag = `${tag}] `;
            }
        }

        if (optionalParams && optionalParams.length > 0) {
            return `${tag}${msg} ${formatLogParams(optionalParams)}`;
        }
        return `${tag}${msg}`;
    }

    public trace(message?: string, ...optionalParams: any[]): void {
        this.log.silly(this._getMessage(message, false, optionalParams));
    }

    public debug(message?: string, ...optionalParams: any[]): void {
        this.log.debug(this._getMessage(message, false, optionalParams));
    }

    public info(message?: string, ...optionalParams: any[]): void {
        this.log.info(this._getMessage(message, true, optionalParams));
    }

    public warn(message?: string, ...optionalParams: any[]): void {
        this.log.warn(this._getMessage(message, true, optionalParams));
    }

    public error(message?: string, ...optionalParams: any[]): void {
        this.log.error(this._getMessage(message, true, optionalParams));
    }
}
