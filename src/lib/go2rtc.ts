/**
 * Helpers around the go2rtc stream pipelines. Deliberately free of imports so they stay testable:
 * lib/utils.ts pulls in \@iobroker/adapter-core and main.ts, which needs a running js-controller.
 */

/**
 * Name of the player page in the www directory, which go2rtc serves from api.static_dir. It keeps
 * the name of the stream page of go2rtc on purpose, so links that were built by hand keep working.
 */
export const PLAYER_PAGE = 'stream.html';

/**
 * Query of the player page for the livestream state. `background=false` lets the player disconnect
 * while its page is not visible - the built-in default keeps decoding behind a switched off display
 * and leaves a consumer attached that never recovers once the producer is gone.
 */
export const PLAYER_QUERY = 'background=false';

/**
 * go2rtc answers with "EOF" when a stream is torn down in the regular way (livestream stopped,
 * maximum duration reached). That is not a failure and must not trigger any error handling.
 *
 * @param error The rejection reason of a stream pipeline
 * @returns true if the stream simply ended instead of breaking
 */
export const isRegularStreamEnd = (error: unknown): boolean => {
    const body = (error as { response?: { body?: unknown } })?.response?.body;
    return typeof body === 'string' && body.startsWith('EOF');
};

/**
 * Tells whether at least one of the stream pipelines ended in an actual failure, so callers can
 * tear the livestream down instead of leaving the camera streaming into nothing.
 *
 * @param results The settled results returned by streamToGo2rtc()
 * @returns true if at least one pipeline broke
 */
export const streamToGo2rtcFailed = (results: Array<PromiseSettledResult<void>>): boolean =>
    results.some(result => result.status === 'rejected' && !isRegularStreamEnd(result.reason));

/**
 * Suffix of the transcoded stream go2rtc registers next to the untouched one for a device that is
 * listed in the compatibility setting.
 */
export const COMPAT_STREAM_SUFFIX = '_compat';

/**
 * Name of the go2rtc stream a player is pointed at. The cameras send up to 2048x1536 High Profile,
 * which old WebViews and kiosk tablets decode as green macroblocks or not at all, so a device
 * listed in the compatibility setting is played from the transcoded stream instead.
 *
 * The device always keeps pushing into the stream named after its serial - only the consumer side
 * changes.
 *
 * @param serial Serial of the device
 * @param compatSerials Serials configured for the compatibility stream
 * @returns The stream name to play from
 */
export const go2rtcStreamName = (serial: string, compatSerials: string[]): string =>
    compatSerials.includes(serial) ? `${serial}${COMPAT_STREAM_SUFFIX}` : serial;

/**
 * go2rtc source of the compatibility stream: the untouched stream of the device, re-encoded to
 * 720p H.264. Audio is copied, so it stays what the camera sent. go2rtc starts one ffmpeg per
 * viewer of this stream, which is why it is opt-in per device.
 *
 * Only the height is fixed. go2rtc 1.9.4 turns width and height into `scale=<width>:<height>`,
 * so a fixed 1280x720 stretched the 4:3 picture of the cameras (2048x1536, 1600x1200) to 16:9.
 * A width of -2 lets ffmpeg keep the aspect ratio and round the width to an even number, which
 * the H.264 encoder requires; -1 could produce an odd width.
 *
 * @param serial Serial of the device
 * @returns The source string for the go2rtc configuration
 */
export const compatStreamSource = (serial: string): string =>
    `ffmpeg:${serial}#video=h264#width=-2#height=720#audio=copy`;

/**
 * Builds the URL of the livestream player page. The page is served by go2rtc itself, because
 * go2rtc answers a WebSocket from a different origin with "403 Forbidden".
 *
 * Plain http on purpose: the adapter never configures TLS for go2rtc, and go2rtc ignores
 * api.tls_listen without a certificate, so an https URL could not work.
 *
 * @param hostname Host go2rtc is reachable at
 * @param apiPort Port of the go2rtc API
 * @param stream Name of the go2rtc stream to play, see go2rtcStreamName()
 * @returns The URL of the player page for that stream
 */
export const buildPlayerUrl = (hostname: string, apiPort: number, stream: string): string =>
    `http://${hostname}:${apiPort}/${PLAYER_PAGE}?src=${encodeURIComponent(stream)}&${PLAYER_QUERY}`;

/**
 * Builds the RTSP URL go2rtc serves a stream at.
 *
 * @param hostname Host go2rtc is reachable at
 * @param rtspPort Port of the go2rtc RTSP server
 * @param stream Name of the go2rtc stream to play, see go2rtcStreamName()
 * @returns The RTSP URL of that stream
 */
export const buildRtspUrl = (hostname: string, rtspPort: number, stream: string): string =>
    `rtsp://${hostname}:${rtspPort}/${encodeURIComponent(stream)}`;

/** One address of a network interface, as os.networkInterfaces() lists it. */
export interface InterfaceAddress {
    address: string;
    family: string | number;
    internal: boolean;
}

/** Interfaces of containers, bridges and tunnels - their addresses are not reachable from the LAN. */
const VIRTUAL_INTERFACE = /^(docker|br-|veth|virbr|lxc|lxd|cni|flannel|cali|tun|tap|wg|zt|tailscale)/i;

const isPrivateIPv4 = (address: string): boolean =>
    /^10\./.test(address) || /^192\.168\./.test(address) || /^172\.(1[6-9]|2\d|3[01])\./.test(address);

/**
 * Picks the address other devices reach the ioBroker host at, for the URLs of the livestreams
 * when no host name is configured. The name of the host ("iobroker") is what the URLs used before,
 * and tablets, phones and dashboards often cannot resolve it.
 *
 * @param interfaces The network interfaces of the host (system.host.*.native.hardware.networkInterfaces)
 * @returns An IPv4 address of the LAN, preferring private ones, or undefined if there is none
 */
export const pickHostAddress = (
    interfaces: Record<string, InterfaceAddress[] | undefined> | undefined,
): string | undefined => {
    const candidates: string[] = [];
    for (const [name, addresses] of Object.entries(interfaces ?? {})) {
        if (VIRTUAL_INTERFACE.test(name)) {
            continue;
        }
        for (const entry of addresses ?? []) {
            const ipv4 = entry.family === 'IPv4' || entry.family === 4;
            if (ipv4 && !entry.internal && !entry.address.startsWith('169.254.')) {
                candidates.push(entry.address);
            }
        }
    }
    return candidates.find(isPrivateIPv4) ?? candidates[0];
};
