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
