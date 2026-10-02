/**
 * The "Streams" tab of the instance settings: every device with a livestream, with the URLs to
 * play it. Deliberately free of adapter imports, so it stays testable without a running
 * js-controller.
 */

export interface StreamInfo {
    serial: string;
    name: string;
    model: string;
    station: string;
    playerUrl: string;
    rtspUrl: string;
    /** Player URL of the untouched stream, for a device listed for the compatibility stream. */
    originalPlayerUrl?: string;
}

export interface OverviewContext {
    /** Language of the admin, everything but German falls back to English. */
    language: string;
    /** No host name is configured - the URLs use this address of the ioBroker host instead. */
    hostnameAuto?: string;
    /** go2rtc is not available on this platform. */
    noGo2rtc?: boolean;
}

const TEXTS = {
    en: {
        empty: 'No device with a livestream was found. The list fills once the adapter is connected to eufy.',
        noGo2rtc: 'go2rtc is not available on this platform - livestreams cannot be played.',
        camera: 'Device',
        station: 'Station',
        player: 'Player',
        rtsp: 'RTSP',
        open: 'open',
        original: 'untouched stream',
        pushOnly: 'The URLs only play while a livestream runs (start_stream).',
        hostname: (host: string) =>
            `No host name is configured, so the URLs use "${host}" of the ioBroker host. If the devices that play the livestream reach the host at another address or name, enter it in the setting "Hostname".`,
    },
    de: {
        empty: 'Kein Gerät mit Livestream gefunden. Die Liste füllt sich, sobald der Adapter mit eufy verbunden ist.',
        noGo2rtc: 'go2rtc ist auf dieser Plattform nicht verfügbar - Livestreams können nicht abgespielt werden.',
        camera: 'Gerät',
        station: 'Station',
        player: 'Player',
        rtsp: 'RTSP',
        open: 'öffnen',
        original: 'unveränderter Stream',
        pushOnly: 'Die URLs spielen nur, solange ein Livestream läuft (start_stream).',
        hostname: (host: string) =>
            `Es ist kein Hostname eingetragen, deshalb verwenden die URLs "${host}" des ioBroker-Hosts. Erreichen die Geräte, die den Livestream abspielen, den Host unter einer anderen Adresse oder einem Namen, trage sie in der Einstellung "Hostname" ein.`,
    },
};

/**
 * Escapes text for HTML.
 *
 * @param value The text
 * @returns The text with the HTML special characters escaped
 */
export const escapeHtml = (value: string): string =>
    value.replace(
        /[&<>"']/g,
        char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char,
    );

/**
 * Builds the HTML of the "Streams" tab.
 *
 * @param streams The devices with a livestream
 * @param context What the notes below the table depend on
 * @returns The HTML shown by the textSendTo control
 */
export const renderStreamOverview = (streams: StreamInfo[], context: OverviewContext): string => {
    const t = context.language === 'de' ? TEXTS.de : TEXTS.en;
    if (context.noGo2rtc) {
        return `<p>${escapeHtml(t.noGo2rtc)}</p>`;
    }
    if (streams.length === 0) {
        return `<p>${escapeHtml(t.empty)}</p>`;
    }

    const cell = 'padding:6px 10px;border-bottom:1px solid rgba(128,128,128,.3);vertical-align:top;text-align:left';
    const code = 'font-family:monospace;font-size:90%;word-break:break-all';
    const link = (url: string, label: string): string =>
        `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(label)}</a>`;

    const rows = [...streams]
        .sort((a, b) => a.station.localeCompare(b.station) || a.name.localeCompare(b.name))
        .map(stream => {
            const player = [
                `${link(stream.playerUrl, t.open)}<br><span style="${code}">${escapeHtml(stream.playerUrl)}</span>`,
            ];
            if (stream.originalPlayerUrl) {
                player.push(`${link(stream.originalPlayerUrl, t.original)}`);
            }
            return [
                '<tr>',
                `<td style="${cell}"><b>${escapeHtml(stream.name)}</b><br><small>${escapeHtml(stream.model)} · ${escapeHtml(stream.serial)}</small></td>`,
                `<td style="${cell}">${escapeHtml(stream.station)}</td>`,
                `<td style="${cell}">${player.join('<br>')}</td>`,
                `<td style="${cell}"><span style="${code}">${escapeHtml(stream.rtspUrl)}</span></td>`,
                '</tr>',
            ].join('');
        });

    const notes = [t.pushOnly];
    if (context.hostnameAuto) {
        notes.push(t.hostname(context.hostnameAuto));
    }

    return [
        '<table style="border-collapse:collapse;width:100%">',
        `<thead><tr>${[t.camera, t.station, t.player, t.rtsp]
            .map(title => `<th style="${cell}">${escapeHtml(title)}</th>`)
            .join('')}</tr></thead>`,
        `<tbody>${rows.join('')}</tbody>`,
        '</table>',
        ...notes.map(note => `<p style="opacity:.8">${escapeHtml(note)}</p>`),
    ].join('');
};
