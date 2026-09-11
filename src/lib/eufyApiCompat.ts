/**
 * Compatibility shims for the Eufy Mega/v6 backend.
 *
 * Development of eufy-security-client has ended (bropat/eufy-security-client#965), so defects that
 * only show up against the migrated v6 backend have to be corrected here. Every shim in this file
 * patches a prototype before EufySecurity.initialize() runs and documents the condition under which
 * it can be deleted again.
 *
 * 1. Success code (see below): the v6 backend answers 200 where the library expects 0.
 * 2. Legacy push check: a migrated account is rejected by the legacy push endpoint forever, but the
 *    rejection is logged as an error on every push reconnect - see applyEufyApiCompatibility().
 * 3. Stale v6 identity: a rejected identity is evicted but the failed call is not retried - same.
 *
 * ## 1. Success code
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
 * Remove this shim once the adapter depends on a library version that accepts both codes.
 *
 * ## 2. Legacy push check
 *
 * `EufySecurity` registers the FCM token on the legacy and on the v6 backend independently and
 * treats push as established if EITHER accepted it. Its own comment states that "a migrated account
 * is rejected by the legacy endpoint", yet `HTTPApi.checkPushToken()` logs that expected rejection
 * at error level:
 *
 *     [http] [HTTPApi.checkPushToken] Check push token - Response code not ok
 *     [{"code":10003,"msg":"Anfrage fehlgeschlagen.",...}]
 *
 * For a migrated account the check can never succeed, but it runs again on every push reconnect,
 * which is what iobroker-community-adapters/ioBroker.eusec#173 reports. The results are not used
 * anywhere either: the library assigns them to `pushCloudRegistered`/`pushCloudChecked` and never
 * reads those again. So the first rejection is remembered and the endpoint is not asked a second
 * time - that keeps the single honest error of a genuinely broken legacy registration while
 * dropping the repetition, and saves two HTTP round trips per reconnect.
 *
 * Remove this shim once the library stops asking the legacy endpoint for migrated accounts.
 *
 * ## 3. Stale v6 identity
 *
 * The v6 session persists the per-cluster ECDH identities, so after a restart the first signed call
 * can be made with an identity the backend has already dropped. `MegaHTTPApi.signedPost()` detects
 * that (`CODE_NEED_NEGOTIATE_KEY`), evicts the cached identities - and then returns the failure to
 * the caller instead of repeating the call, so the re-handshake it just triggered is wasted:
 *
 *     [http] [MegaHTTPApi.signedPost] MegaApi identity rejected - evicting cached identities [{"code":4404}]
 *     [main] [MegaTransition.registerMegaPushToken] v6 push: register_push_token returned a non-zero code
 *     [main] Push notification connection closed
 *
 * On every adapter start push therefore reports itself closed first and only establishes ~10s later,
 * on the next attempt. `MegaHTTPApi.call()` is the single funnel every signed v6 request goes
 * through, so retrying there once - after the eviction, with a freshly negotiated identity - covers
 * push registration and every other v6 call.
 *
 * Remove this shim once the library retries an evicted identity itself.
 */

import { HTTPApi, MegaHTTPApi, ResponseErrorCode } from 'eufy-security-client';
import type { ApiResponse, HTTPApiRequest, MegaResult } from 'eufy-security-client';

/** Legacy application success code of the Eufy API. */
const LEGACY_SUCCESS_CODE = ResponseErrorCode.CODE_OK;

/** HTTP style success code the Mega/v6 backend returns instead. It is not a member of ResponseErrorCode. */
const HTTP_SUCCESS_CODE = 200;

/** Codes with which the v6 backend rejects an identity; MegaHTTPApi evicts the cache on both. */
const IDENTITY_REJECTED_CODES: readonly number[] = [
    ResponseErrorCode.CODE_NEED_NEGOTIATE_KEY,
    ResponseErrorCode.CODE_SIGNATURE_ERROR,
];

/**
 * Whether a v6 response says the identity it was signed with is no longer accepted. MegaHTTPApi has
 * dropped the cached identities by the time such a response is returned, so repeating the call
 * negotiates a new one.
 *
 * @param result The parsed body of a v6 API response
 * @returns true if the call should be repeated with a freshly negotiated identity
 */
export const isIdentityRejected = (result: unknown): boolean => {
    if (result === null || typeof result !== 'object') {
        return false;
    }
    const { code } = result as { code?: unknown };
    return typeof code === 'number' && IDENTITY_REJECTED_CODES.includes(code);
};

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
 * Applies every shim described at the top of this module. Must run before
 * EufySecurity.initialize(); applying it more than once is a no-op.
 *
 * @param log Called once per shim, the first time it has to correct something
 */
export const applyEufyApiCompatibility = (log: (message: string) => void): void => {
    if (patched) {
        return;
    }
    patched = true;

    // 1. Rewrite the HTTP style success code so the library understands its own responses.
    const originalRequest = HTTPApi.prototype.request;
    let reportedSuccessCode = false;

    HTTPApi.prototype.request = async function (
        request: HTTPApiRequest,
        withoutUrlPrefix?: boolean,
    ): Promise<ApiResponse> {
        const response = await originalRequest.call(this, request, withoutUrlPrefix);
        if (normalizeSuccessCode(response?.data) && !reportedSuccessCode) {
            reportedSuccessCode = true;
            log(
                'The Eufy API answers with the HTTP style code 200 where the legacy code 0 is expected. The adapter normalizes it - see bropat/eufy-security-client#975.',
            );
        }
        return response;
    };

    // 2. Ask the legacy push endpoint once. A migrated account is rejected by it for good.
    const originalCheckPushToken = HTTPApi.prototype.checkPushToken;
    let legacyPushRejected = false;

    HTTPApi.prototype.checkPushToken = async function (): Promise<boolean> {
        if (legacyPushRejected) {
            return false;
        }
        const accepted = await originalCheckPushToken.call(this);
        if (!accepted) {
            legacyPushRejected = true;
            log(
                'The legacy push endpoint rejected this account, which is expected once it has been migrated to the v6 backend. The adapter stops asking it - push is delivered over v6.',
            );
        }
        return accepted;
    };

    // 3. Repeat a v6 call whose identity the backend rejected, using the renegotiated one.
    const originalCall = MegaHTTPApi.prototype.call;
    let reportedIdentityRetry = false;

    MegaHTTPApi.prototype.call = async function (host: string, path: string, payload: unknown): Promise<MegaResult> {
        const result = await originalCall.call(this, host, path, payload);
        if (!isIdentityRejected(result)) {
            return result;
        }
        if (!reportedIdentityRetry) {
            reportedIdentityRetry = true;
            log(
                'The v6 backend rejected a stored identity. The adapter repeats the call with a renegotiated one instead of reporting push as closed.',
            );
        }
        return originalCall.call(this, host, path, payload);
    };
};
