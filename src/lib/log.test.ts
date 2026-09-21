import { expect } from 'chai';

import { formatLogParams, ioBrokerLogger } from './log';

describe('log => formatLogParams', () => {
    it('should keep name and message of an error', () => {
        expect(JSON.parse(formatLogParams([new TypeError('boom')]))).to.deep.equal([
            { name: 'TypeError', message: 'boom' },
        ]);
    });

    it('should keep the own properties and the cause of an error', () => {
        const error = Object.assign(new Error('outer', { cause: new Error('inner') }), { context: { serial: 'T1' } });
        expect(JSON.parse(formatLogParams([error]))).to.deep.equal([
            {
                name: 'Error',
                message: 'outer',
                context: { serial: 'T1' },
                cause: { name: 'Error', message: 'inner' },
            },
        ]);
    });

    it('should not throw on a circular structure', () => {
        const circular: Record<string, unknown> = { a: 1 };
        circular.self = circular;
        expect(JSON.parse(formatLogParams([circular]))).to.deep.equal([{ a: 1, self: '[Circular]' }]);
    });

    it('should serialize plain values as before', () => {
        expect(formatLogParams(['x', 1, null, { a: [true] }])).to.equal('["x",1,null,{"a":[true]}]');
    });

    it('should serialize a bigint instead of throwing', () => {
        expect(formatLogParams([10n])).to.equal('["10"]');
    });

    it('should serialize an empty parameter list', () => {
        expect(formatLogParams([])).to.equal('[]');
    });
});

describe('log => ioBrokerLogger', () => {
    it('should write the message of an error passed as parameter', () => {
        const lines: string[] = [];
        const logger = new ioBrokerLogger({ error: (line: string) => lines.push(line) } as unknown as ioBroker.Logger);
        logger.error('Start livestream - Error', new Error('station not connected'));
        expect(lines).to.deep.equal(['Start livestream - Error [{"name":"Error","message":"station not connected"}]']);
    });
});
