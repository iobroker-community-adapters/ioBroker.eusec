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
var go2rtc_exports = {};
__export(go2rtc_exports, {
  isRegularStreamEnd: () => isRegularStreamEnd,
  streamToGo2rtcFailed: () => streamToGo2rtcFailed
});
module.exports = __toCommonJS(go2rtc_exports);
const isRegularStreamEnd = (error) => {
  var _a;
  const body = (_a = error == null ? void 0 : error.response) == null ? void 0 : _a.body;
  return typeof body === "string" && body.startsWith("EOF");
};
const streamToGo2rtcFailed = (results) => results.some((result) => result.status === "rejected" && !isRegularStreamEnd(result.reason));
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  isRegularStreamEnd,
  streamToGo2rtcFailed
});
//# sourceMappingURL=go2rtc.js.map
