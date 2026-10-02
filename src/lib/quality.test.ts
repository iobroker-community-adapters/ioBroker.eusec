import { expect } from 'chai';

import { fixedStreamingQualities, isAutoStreamingQuality, resolveStreamingQuality } from './quality';

// The states of the library (eufy-security-client 4.1) for the device families that differ.
const CAMERA = { 0: 'Auto', 1: 'Low', 2: 'Medium', 3: 'High' };
const CAMERA_3 = { 5: 'Auto', 6: 'Low', 7: 'Medium', 8: 'High', 10: 'Ultra 4K' };
const C35 = { 0: 'Auto', 1: 'High', 2: 'Medium' };
const PROFESSIONAL = { 5: 'Auto', 6: '720P', 7: '1080P', 8: '2K', 10: 'Ultra 4K' };
const BATTERY_DOORBELL = {
    0: 'Auto / Low Encoding',
    1: 'Low / Low Encoding',
    2: 'Medium / Low Encoding',
    3: 'High / Low Encoding',
    5: 'Auto / High Encoding',
    6: 'Low / High Encoding',
    7: 'Medium / High Encoding',
    8: 'High / High Encoding',
};

describe('quality => resolveStreamingQuality', () => {
    it('should keep the quality while the setting is off', () => {
        expect(resolveStreamingQuality(CAMERA, 0, '')).to.deep.equal({ kind: 'keep' });
        expect(resolveStreamingQuality(CAMERA, 0, 'unknown')).to.deep.equal({ kind: 'keep' });
    });

    it('should keep a device that already streams at the wanted quality', () => {
        expect(resolveStreamingQuality(CAMERA, 2, 'medium')).to.deep.equal({ kind: 'keep' });
        expect(resolveStreamingQuality(BATTERY_DOORBELL, 7, 'medium')).to.deep.equal({ kind: 'keep' });
    });

    it('should resolve the value through the label, not a fixed number', () => {
        expect(resolveStreamingQuality(CAMERA, 0, 'high')).to.deep.equal({
            kind: 'set',
            value: 3,
            from: 'Auto',
            to: 'High',
        });
        expect(resolveStreamingQuality(CAMERA_3, 5, 'high')).to.deep.equal({
            kind: 'set',
            value: 8,
            from: 'Auto',
            to: 'High',
        });
        expect(resolveStreamingQuality(C35, 0, 'medium')).to.deep.equal({
            kind: 'set',
            value: 2,
            from: 'Auto',
            to: 'Medium',
        });
    });

    it('should keep the encoding of a battery doorbell', () => {
        expect(resolveStreamingQuality(BATTERY_DOORBELL, 0, 'medium')).to.deep.equal({
            kind: 'set',
            value: 2,
            from: 'Auto / Low Encoding',
            to: 'Medium / Low Encoding',
        });
        expect(resolveStreamingQuality(BATTERY_DOORBELL, 5, 'low')).to.deep.equal({
            kind: 'set',
            value: 6,
            from: 'Auto / High Encoding',
            to: 'Low / High Encoding',
        });
    });

    it('should report a quality the device does not offer', () => {
        expect(resolveStreamingQuality(C35, 0, 'low')).to.deep.equal({ kind: 'unavailable', wanted: 'Low' });
        expect(resolveStreamingQuality(PROFESSIONAL, 5, 'high')).to.deep.equal({ kind: 'unavailable', wanted: 'High' });
        expect(resolveStreamingQuality(undefined, 0, 'high')).to.deep.equal({ kind: 'unavailable', wanted: 'High' });
    });

    it('should cope with a value that has no label', () => {
        expect(resolveStreamingQuality(CAMERA, 9, 'low')).to.deep.equal({
            kind: 'set',
            value: 1,
            from: '9',
            to: 'Low',
        });
    });
});

describe('quality => isAutoStreamingQuality', () => {
    it('should detect every "Auto" label', () => {
        expect(isAutoStreamingQuality('Auto')).to.equal(true);
        expect(isAutoStreamingQuality('Auto / High Encoding')).to.equal(true);
        expect(isAutoStreamingQuality('High')).to.equal(false);
        expect(isAutoStreamingQuality(undefined)).to.equal(false);
    });
});

describe('quality => fixedStreamingQualities', () => {
    it('should list the qualities without "Auto"', () => {
        expect(fixedStreamingQualities(CAMERA_3)).to.equal('6 = Low, 7 = Medium, 8 = High, 10 = Ultra 4K');
        expect(fixedStreamingQualities(undefined)).to.equal('');
    });
});
