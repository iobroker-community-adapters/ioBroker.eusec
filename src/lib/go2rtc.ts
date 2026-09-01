/**
 * Helpers around the go2rtc stream pipelines. Deliberately free of imports so they stay testable:
 * lib/utils.ts pulls in @iobroker/adapter-core and main.ts, which needs a running js-controller.
 */

/**
 * go2rtc answers with "EOF" when a stream is torn down in the regular way (livestream stopped,
 * maximum duration reached). That is not a failure and must not trigger any error handling.
 *
 * @param error The rejection reason of a stream pipeline
 * @returns true if the stream simply ended instead of breaking
 */
export const isRegularStreamEnd = (error: unknown): boolean => {
    const body = (error as { response?: { body?: unknown } })?.response?.body;
    return typeof body === "string" && body.startsWith("EOF");
};

/**
 * Tells whether at least one of the stream pipelines ended in an actual failure, so callers can
 * tear the livestream down instead of leaving the camera streaming into nothing.
 *
 * @param results The settled results returned by streamToGo2rtc()
 * @returns true if at least one pipeline broke
 */
export const streamToGo2rtcFailed = (results: Array<PromiseSettledResult<void>>): boolean =>
    results.some((result) => result.status === "rejected" && !isRegularStreamEnd(result.reason));
