/**
 * Compatibility shim for the Eufy Mega/v6 backend.
 *
 * Eufy started answering with the HTTP style code 200 in the JSON body of endpoints that used to
 * return the legacy application code 0. eufy-security-client accepts only 0
 * (`ResponseErrorCode.CODE_OK`) and therefore reports perfectly valid answers as failures:
 *
 *     [http] [HTTPApi.getPassportProfile] Get passport profile - Response code not ok
 *     [{"code":200,"msg":"","data":{...}}]
 *
 * The login never completes after that, and the house, station and device lists stay empty.
 *
 * Upstream carries the fix in bropat/eufy-security-client#975, but development of that library has
 * ended (bropat/eufy-security-client#965), so it will most likely never be released. 21 of the 22
 * affected comparisons read `response.data` of the public `HTTPApi.request()`, so normalizing the
 * code in that single funnel repairs all of them at once.
 *
 * The 22nd is the static `HTTPApi.getApiBaseFromCloud()`, which calls got directly and talks to a
 * different host (extend.eufylife.com). It is deliberately left untouched: a failure there aborts
 * the login with an ApiBaseLoadError long before a profile is ever requested, which is not the
 * behaviour reported in the field.
 *
 * Remove this module once the adapter depends on a library version that accepts both codes.
 */

import { HTTPApi, ResponseErrorCode } from 'eufy-security-client';
import type { ApiResponse, HTTPApiRequest } from 'eufy-security-client';

/** Legacy application success code of the Eufy API. */
const LEGACY_SUCCESS_CODE = ResponseErrorCode.CODE_OK;

/** HTTP style success code the Mega/v6 backend returns instead. It is not a member of ResponseErrorCode. */
const HTTP_SUCCESS_CODE = 200;

/**
 * Rewrites the HTTP style success code of a response body to the legacy one, in place. Only the
 * code is touched - the encrypted payload in `data` is passed through untouched.
 *
 * @param data The parsed body of an Eufy API response
 * @returns true if the code was rewritten, false if the body was left as it was
 */
export const normalizeSuccessCode = (data: unknown): boolean => {
    if (data === null || typeof data !== 'object') {
        return false;
    }
    const result = data as { code?: unknown };
    if (result.code !== HTTP_SUCCESS_CODE) {
        return false;
    }
    result.code = LEGACY_SUCCESS_CODE;
    return true;
};

let patched = false;

/**
 * Wraps HTTPApi.request() so every response body carries a success code the library understands.
 * Must run before EufySecurity.initialize(); applying it more than once is a no-op.
 *
 * @param log Called once, on the first response that actually needed the rewrite
 */
export const applyEufyApiCompatibility = (log: (message: string) => void): void => {
    if (patched) {
        return;
    }
    patched = true;

    const original = HTTPApi.prototype.request;
    let reported = false;

    HTTPApi.prototype.request = async function (
        request: HTTPApiRequest,
        withoutUrlPrefix?: boolean,
    ): Promise<ApiResponse> {
        const response = await original.call(this, request, withoutUrlPrefix);
        if (normalizeSuccessCode(response?.data) && !reported) {
            reported = true;
            log(
                'The Eufy API answers with the HTTP style code 200 where the legacy code 0 is expected. The adapter normalizes it - see bropat/eufy-security-client#975.',
            );
        }
        return response;
    };
};
