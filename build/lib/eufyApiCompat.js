"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var eufyApiCompat_exports = {};
__export(eufyApiCompat_exports, {
  applyEufyApiCompatibility: () => applyEufyApiCompatibility,
  normalizeSuccessCode: () => normalizeSuccessCode
});
module.exports = __toCommonJS(eufyApiCompat_exports);
var import_eufy_security_client = require("eufy-security-client");
const LEGACY_SUCCESS_CODE = import_eufy_security_client.ResponseErrorCode.CODE_OK;
const HTTP_SUCCESS_CODE = 200;
const normalizeSuccessCode = (data) => {
  if (data === null || typeof data !== "object") {
    return false;
  }
  const result = data;
  if (result.code !== HTTP_SUCCESS_CODE) {
    return false;
  }
  result.code = LEGACY_SUCCESS_CODE;
  return true;
};
let patched = false;
const applyEufyApiCompatibility = (log) => {
  if (patched) {
    return;
  }
  patched = true;
  const original = import_eufy_security_client.HTTPApi.prototype.request;
  let reported = false;
  import_eufy_security_client.HTTPApi.prototype.request = async function(request, withoutUrlPrefix) {
    const response = await original.call(this, request, withoutUrlPrefix);
    if (normalizeSuccessCode(response == null ? void 0 : response.data) && !reported) {
      reported = true;
      log(
        "The Eufy API answers with the HTTP style code 200 where the legacy code 0 is expected. The adapter normalizes it - see bropat/eufy-security-client#975."
      );
    }
    return response;
  };
};
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  applyEufyApiCompatibility,
  normalizeSuccessCode
});
//# sourceMappingURL=eufyApiCompat.js.map
