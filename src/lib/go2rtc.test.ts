import { expect } from 'chai';

import { buildPlayerUrl, streamToGo2rtcFailed } from './go2rtc';

const fulfilled = (): PromiseSettledResult<void> => ({ status: 'fulfilled', value: undefined });
const rejected = (reason: unknown): PromiseSettledResult<void> => ({ status: 'rejected', reason });

describe('go2rtc => streamToGo2rtcFailed', () => {
    it('should report no failure when both pipelines finished', () => {
        expect(streamToGo2rtcFailed([fulfilled(), fulfilled()])).to.equal(false);
    });

    it('should treat the EOF answer of go2rtc as a regular stream end', () => {
        expect(streamToGo2rtcFailed([rejected({ response: { body: 'EOF' } }), fulfilled()])).to.equal(false);
    });

    it('should report a failure when a pipeline broke', () => {
        expect(streamToGo2rtcFailed([rejected(new Error('connect ECONNREFUSED')), fulfilled()])).to.equal(true);
    });

    it('should report a failure for rejections without a response body', () => {
        expect(streamToGo2rtcFailed([fulfilled(), rejected(undefined)])).to.equal(true);
    });
});

describe('go2rtc => buildPlayerUrl', () => {
    it('should keep the page name of go2rtc so hand made links stay valid, and disable the background mode', () => {
        expect(buildPlayerUrl('iobroker', 1984, 'T8410P00')).to.equal(
            'http://iobroker:1984/stream.html?src=T8410P00&background=false',
        );
    });

    it('should always build a plain http URL, because go2rtc is never configured for TLS', () => {
        expect(buildPlayerUrl('iobroker', 1984, 'T8410P00')).to.match(/^http:\/\//);
    });

    it('should encode a serial that is not URL safe', () => {
        expect(buildPlayerUrl('iobroker', 1984, 'a b&c')).to.contain('?src=a%20b%26c');
    });
});
