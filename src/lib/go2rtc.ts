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
 * Builds the URL of the livestream player page. The page is served by go2rtc itself, because
 * go2rtc answers a WebSocket from a different origin with "403 Forbidden".
 *
 * Plain http on purpose: the adapter never configures TLS for go2rtc, and go2rtc ignores
 * api.tls_listen without a certificate, so an https URL could not work.
 *
 * @param hostname Host go2rtc is reachable at
 * @param apiPort Port of the go2rtc API
 * @param serial Serial of the device to stream
 * @returns The URL of the player page for that device
 */
export const buildPlayerUrl = (hostname: string, apiPort: number, serial: string): string =>
    `http://${hostname}:${apiPort}/${PLAYER_PAGE}?src=${encodeURIComponent(serial)}&${PLAYER_QUERY}`;
