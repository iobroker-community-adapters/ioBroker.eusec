import { expect } from 'chai';

import { streamToGo2rtcFailed } from './go2rtc';

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
