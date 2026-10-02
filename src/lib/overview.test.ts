import { expect } from 'chai';

import { escapeHtml, renderStreamOverview, type StreamInfo } from './overview';

const camera = (overrides: Partial<StreamInfo> = {}): StreamInfo => ({
    serial: 'T8134520241455AC',
    name: 'Garten Pool',
    model: 'T8134',
    station: 'HomeBase',
    playerUrl: 'http://192.168.188.40:1984/stream.html?src=T8134520241455AC&background=false',
    rtspUrl: 'rtsp://192.168.188.40:8554/T8134520241455AC',
    ...overrides,
});

describe('overview => renderStreamOverview', () => {
    it('should list every device with a link to its player and the RTSP URL', () => {
        const html = renderStreamOverview([camera()], { language: 'en' });
        expect(html).to.contain('<b>Garten Pool</b>');
        expect(html).to.contain(
            'href="http://192.168.188.40:1984/stream.html?src=T8134520241455AC&amp;background=false"',
        );
        expect(html).to.contain('target="_blank"');
        expect(html).to.contain('rtsp://192.168.188.40:8554/T8134520241455AC');
    });

    it('should sort by station and name', () => {
        const html = renderStreamOverview(
            [
                camera({ name: 'B', station: 'S2' }),
                camera({ name: 'C', station: 'S1' }),
                camera({ name: 'A', station: 'S2' }),
            ],
            { language: 'en' },
        );
        expect(html.indexOf('<b>C</b>')).to.be.lessThan(html.indexOf('<b>A</b>'));
        expect(html.indexOf('<b>A</b>')).to.be.lessThan(html.indexOf('<b>B</b>'));
    });

    it('should offer the untouched stream of a device with a compatibility stream', () => {
        const html = renderStreamOverview([camera({ originalPlayerUrl: 'http://h:1984/stream.html?src=T81' })], {
            language: 'en',
        });
        expect(html).to.contain('untouched stream');
    });

    it('should explain that the URLs only play while a livestream runs', () => {
        expect(renderStreamOverview([camera()], { language: 'en' })).to.contain('start_stream');
    });

    it('should point out a host name that devices may not resolve', () => {
        const html = renderStreamOverview([camera()], {
            language: 'de',
            hostnameAuto: '192.168.188.40',
        });
        expect(html).to.contain('&quot;192.168.188.40&quot;');
        expect(html).to.contain('Hostname');
    });

    it('should say so when there is nothing to show', () => {
        expect(renderStreamOverview([], { language: 'en' })).to.contain('No device');
        expect(renderStreamOverview([camera()], { language: 'en', noGo2rtc: true })).to.contain('not available');
    });

    it('should not let a device name inject markup', () => {
        const html = renderStreamOverview([camera({ name: '<img src=x onerror=alert(1)>' })], {
            language: 'en',
        });
        expect(html).not.to.contain('<img');
        expect(escapeHtml(`"'&<>`)).to.equal('&quot;&#39;&amp;&lt;&gt;');
    });
});
