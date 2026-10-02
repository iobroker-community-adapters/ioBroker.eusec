import { expect } from 'chai';

import {
    buildPlayerUrl,
    buildRtspUrl,
    compatStreamSource,
    go2rtcStreamName,
    pickHostAddress,
    streamToGo2rtcFailed,
} from './go2rtc';

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

describe('go2rtc => go2rtcStreamName', () => {
    it('should play the untouched stream of a device that is not configured for compatibility', () => {
        expect(go2rtcStreamName('T8410P00', [])).to.equal('T8410P00');
        expect(go2rtcStreamName('T8410P00', ['T84A1P00'])).to.equal('T8410P00');
    });

    it('should play the transcoded stream of a configured device', () => {
        expect(go2rtcStreamName('T84A1P00', ['T8410P00', 'T84A1P00'])).to.equal('T84A1P00_compat');
    });

    it('should build the compatibility stream from the stream the device pushes into', () => {
        expect(compatStreamSource('T84A1P00')).to.match(/^ffmpeg:T84A1P00#video=h264#.*#audio=copy$/);
    });

    it('should fix only the height of the compatibility stream, so the aspect ratio is kept', () => {
        // go2rtc makes "scale=<width>:<height>" of these; 1280x720 stretched 4:3 cameras to 16:9.
        const source = compatStreamSource('T84A1P00');
        expect(source).to.include('#height=720');
        expect(source).to.include('#width=-2');
        expect(source).not.to.match(/#width=\d/);
    });
});

describe('go2rtc => buildRtspUrl', () => {
    it('should build the URL of the go2rtc RTSP server', () => {
        expect(buildRtspUrl('192.168.1.2', 8554, 'T8410P00')).to.equal('rtsp://192.168.1.2:8554/T8410P00');
    });

    it('should encode a stream name that is not URL safe', () => {
        expect(buildRtspUrl('iobroker', 8554, 'a b')).to.equal('rtsp://iobroker:8554/a%20b');
    });
});

describe('go2rtc => pickHostAddress', () => {
    const v4 = (address: string, internal = false): { address: string; family: string; internal: boolean } => ({
        address,
        family: 'IPv4',
        internal,
    });

    it('should pick the LAN address instead of loopback and IPv6', () => {
        expect(
            pickHostAddress({
                lo: [v4('127.0.0.1', true), { address: '::1', family: 'IPv6', internal: true }],
                eth0: [v4('192.168.188.40'), { address: 'fe80::1', family: 'IPv6', internal: false }],
            }),
        ).to.equal('192.168.188.40');
    });

    it('should skip container bridges and tunnels', () => {
        expect(
            pickHostAddress({ docker0: [v4('172.17.0.1')], 'br-1234': [v4('172.18.0.1')], ens18: [v4('10.0.0.5')] }),
        ).to.equal('10.0.0.5');
        expect(pickHostAddress({ wg0: [v4('10.8.0.1')], tailscale0: [v4('100.64.0.1')] })).to.equal(undefined);
    });

    it('should prefer a private address and skip link-local ones', () => {
        expect(pickHostAddress({ eth0: [v4('169.254.10.10'), v4('84.1.2.3'), v4('172.20.1.2')] })).to.equal(
            '172.20.1.2',
        );
        expect(pickHostAddress({ eth0: [v4('84.1.2.3')] })).to.equal('84.1.2.3');
    });

    it('should accept the numeric family of older node versions', () => {
        expect(pickHostAddress({ eth0: [{ address: '192.168.1.2', family: 4, internal: false }] })).to.equal(
            '192.168.1.2',
        );
    });

    it('should give up when there is nothing to pick', () => {
        expect(pickHostAddress(undefined)).to.equal(undefined);
        expect(pickHostAddress({ lo: [v4('127.0.0.1', true)] })).to.equal(undefined);
    });
});
