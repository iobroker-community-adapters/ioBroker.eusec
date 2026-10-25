# Older changes

## 3.4.0 (2026-10-02)
- (typhosj) Floodlight Cam E30 (T8426): preset positions are now sent to the camera (before, writing `preset_position`, `save_preset_position` or `delete_preset_position` had no effect), and the livestream is no longer rejected with `ERROR_INVALID_ACCOUNT`. The camera now gets the commands of the Floodlight Cam E340, which the library already defines it like (reported in the forum)
- (hdering) **Changed URLs:** without a configured host name, the livestream URLs (states `livestream`, `livestream_rtsp`) now use the IPv4 address in the LAN of the ioBroker host the instance runs on instead of the name of the first ioBroker host (e.g. `http://192.168.1.10:1984/...` instead of `http://iobroker:1984/...`). Tablets, phones and dashboards often cannot resolve the name, and with several hosts the first one is not necessarily the one that runs go2rtc. Visualizations and scripts that store the URL get the new one with the next livestream; to keep a name, enter it in the setting "Hostname"
- (hdering) New setting "Start livestreams on demand": the livestream of a camera starts as soon as its player page or RTSP URL is opened and stops shortly after the last viewer left, so `start_stream` is no longer needed and a dashboard shows a picture right away. A livestream that ends at the maximum duration is started again while somebody still watches. A station carries one livestream at a time: while one of its cameras is watched, the player of another one says which camera that is and starts by itself once the station is free, and a paused player releases the station. Starts the camera acknowledges without sending anything are retried. The states `livestream` and `livestream_rtsp` always carry the URL in this mode. go2rtc's player page and API port have no authentication, so every device in the network that reaches them can wake the cameras. Off by default
- (hdering) New tab "Streams" in the instance settings: every device with a livestream with its station, the player URL to open and the RTSP URL - no need to look the streams up in go2rtc anymore
- (hdering) New setting "Livestream quality": sets the streaming quality of every camera to low, medium or high before its livestream starts, so no camera streams at "Auto", where it changes the resolution mid-stream and browsers show a green or frozen picture. The encoding of battery doorbells ("Medium / Low Encoding") is kept, devices that name their qualities by resolution ("1080P", "2K HD") are left alone. Off by default. The warning about the "Auto" quality is now logged once per device instead of at every livestream start, and names the state to change and the fixed qualities the device offers
- (hdering) New setting "Wait for camera data (sec)", 15 seconds by default: a livestream is no longer given up after 5 seconds without data. Battery cameras that first have to wake up often need longer, and their livestream then ended with "we haven't received any data for 5 seconds" before the first frame
- (hdering) The maximum livestream duration counts from the first picture instead of from the start command, so a camera that needs a minute to wake up no longer loses that minute of its livestream
- (hdering) Livestream: the audio track (or, with a slow camera, the whole stream) no longer breaks after 5 seconds with `socket hang up`. go2rtc drops connections whose request header does not arrive within 5 seconds, and the adapter only sent it with the first data. A livestream that already ended is no longer stopped a second time, which logged a misleading warning


## 3.3.0 (2026-09-21)
- (typhosj) **Breaking:** the tilt down button of pan and tilt cameras is renamed from `titl_down` to `tilt_down`. The update moves the existing object with its name and custom settings (e.g. history); scripts and visualizations that use the old id have to be changed to `tilt_down`
- (typhosj) New setting "Devices with a compatibility stream": the livestream of a camera listed there is re-encoded to 720p H.264, keeping the aspect ratio of the camera, before it reaches the player, which makes it playable on old WebViews, kiosk tablets and hardware decoders that cannot handle the resolution the camera sends. The states `livestream` and `livestream_rtsp` of that camera point at the transcoded stream, the untouched one stays available under the serial number. Transcoding costs CPU on the ioBroker host while such a stream is watched, which is why it is off by default and set per device (#153)
- (typhosj) Talkback: devices with a speaker get the state `talkback_play`. Writing an http(s) URL or an absolute file path to it plays that audio through the device; a livestream is started for it if none is running and stopped again afterwards (#34)
- (typhosj) New setting "Battery devices that stay connected": standalone battery devices on permanent power (power supply or solar panel) listed there keep their P2P connection instead of losing it 30 seconds after the last command, and are reconnected when it drops. It drains the battery of a device that is not on permanent power (#33)
- (typhosj) The eufyCam C31 (T817L) is no longer an unknown device without states; the adapter handles it like the SoloCam Spotlight 1080, which gives it livestream, motion and person detection, light and alarm. Pan and tilt are not available yet (#156)
- (typhosj) Installing the adapter now removes only `--security-revert=CVE-2023-46809` from the node process parameters of an instance instead of clearing them all, so parameters such as `--max-old-space-size` survive an update. A failure there no longer aborts the installation
- (typhosj) Event pictures that arrive in a format the adapter cannot decrypt (e.g. `v8_eufysecurity`) are now loaded from the HomeBase over P2P instead, the way the picture is loaded when the adapter starts. The picture appears about a minute after the event, once the station has stored it (#136)
- (typhosj) Livestreams no longer fail with "RSA_PKCS1_PADDING is no longer supported for private decryption" on node.js builds that refuse RSA PKCS#1 v1.5 decryption; the stream key is now decrypted by node-rsa's own implementation (#144)
- (typhosj) Error messages in the log show the actual error again; before, an error passed along with a log line was written as `{}`, and an error with circular references could not be logged at all
- (typhosj) A device or station property whose state had no value yet now receives its updates; before, such a state stayed empty until the adapter was restarted
- (typhosj) The adapter no longer rewrites the object of every property state on each start, only the ones whose definition actually changed
- (typhosj) A station that disconnects no longer causes warnings about missing `livestream` states for sensors, locks and other devices without a livestream
- (typhosj) The `chime` message command now always answers exactly once: with an error if parameters are missing (before: no answer at all) and only with "not supported" for a station without chime (before: also "chime command sent")
- (typhosj) The state `set_privacy_angle` is named "Set Privacy Angle" instead of "Set Default Angle"; existing objects are renamed on update unless their name was changed by hand
- (typhosj) A channel named "unknown" is no longer deleted on start while it still holds states that have no value yet; only channels without any object below them are removed
- (typhosj) Update migrations compare adapter versions correctly beyond x.9 (3.10.0 was treated as older than 3.9.0)
- (typhosj) Removed unused code and the no longer needed dependencies `@bropat/fluent-ffmpeg` and `fs-extra`

## 3.2.1 (2026-09-18)
- (typhosj) An event picture that cannot be decoded no longer replaces the last picture with a `<serial>.unknown` file; `picture_url` and `picture_html` keep the previous picture and a warning names the device, the data length and the image format (#136)

## 3.2.0 (2026-09-15)
- (typhosj) Pan and tilt cameras expose their four PTZ preset positions: `preset_position` moves the camera to a preset, `save_preset_position` stores the current position in one and `delete_preset_position` clears one. The states are only created for devices that report the matching command (#155)

## 3.1.0 (2026-09-03)
- (typhosj) The adapter requires node.js >= 24 now as`eufy-security-client` 4.x requires `node >=24` itself
- (typhosj) The `livestream`, `livestream_rtsp` and `rtsp_stream_url` states are emptied instead of deleted when a stream ends. 
- (typhosj) Removed the "HTTPS streaming url" setting. The adapter never configures TLS for go2rtc and go2rtc ignores `api.tls_listen` without a certificate, so the option only ever produced a livestream URL that could not be opened. The URL is built with `http` now
- (typhosj) The livestream page (`http://<host>:1984/stream.html?src=<serial>`) is now served by the adapter, with the defaults that make a stream unstable on weak clients such as a Fire tablet
- (typhosj) The `livestream` state now carries `&background=false`, so the player disconnects while its page is not visible. Without it the browser keeps decoding behind a switched off display and leaves a consumer attached that never recovers once the producer is gone
- (typhosj) go2rtc serves its web pages from the adapter directory now (`api.static_dir`). That replaces the files embedded in go2rtc, so the stream list, the log page, the link list and the WebRTC viewer are shipped along and keep answering.

## 3.0.2 (2026-09-02)
- (copilot) Adapter requires node.js >= 22 now
- (copilot) Adapter requires admin >= 7.7.22 now
- (@GermanBluefox) Refactoring
- (@GermanBluefox) Fixed login failing with `Get passport profile - Response code not ok` since the eufy cloud started answering successful requests with code 200 instead of 0 (see [bropat/eufy-security-client#975](https://github.com/bropat/eufy-security-client/pull/975))
- (typhosj) Fixed livestreaming being broken when go2rtc is configured to use an API port other than 1984, and the eufy livestream is now stopped when streaming into go2rtc fails ([#151](https://github.com/iobroker-community-adapters/ioBroker.eusec/pull/151), [#160](https://github.com/iobroker-community-adapters/ioBroker.eusec/issues/160))
- (typhosj) go2rtc is now supervised and restarted if it terminates unexpectedly, the livestream states are cleared when a station disconnects, and a warning is logged when a camera streams at "Auto" quality ([#152](https://github.com/iobroker-community-adapters/ioBroker.eusec/pull/152))
- (@GermanBluefox) The warning about the "Auto" streaming quality now also covers devices where "Auto" is not value 0 (eufyCam 3, Professional models and battery doorbells)
- (@GermanBluefox) Removed the obsolete CVE-2023-46809 workaround for node.js 20 from the adapter startup
- (@GermanBluefox) Pinned eufy-security-client to 4.1.1-1 and removed the unused packages mime and @types/ffmpeg-static

## 2.0.3 (2025-10-26)

- (mcm1957) Remove fix for CVE-2023-46809 for node.js 22 and newer

## 2.0.0 (2025-10-26)

- (mcm1957) Adapter has been migrated to iobroker-community-adapters organisation
- (mcm1957) Adapter requires node.js >= 20, js-controller >= 6.0.11 and admin >= 7.6.17 now
- (mcm1957) Dependencies have been updated

## 1.3.3 (2024-09-28)

* (bropat) Updated version of the package eufy-security-client (3.1.1)
* (bropat) Further details can be found in the changelog of eufy-security-client (3.1.1)

## 1.3.2 (2024-09-10)

* (bropat) Fixed issue #440

## 1.3.1 (2024-09-08)

* (bropat) Fixed issue #436
* (bropat) Fixed issue #439

## 1.3.0 (2024-08-27)

* (bropat) Requires ioBroker.admin version >= 7.0.12
* (bropat) Requires ioBroker.js-controller version >= 6.0.0
* (bropat) Requires node version >= 20
* (bropat) Added new setting to choose country indipendently of ioBroker setting
* (bropat) New go2rtc streaming implementation
* (bropat) Added messagebox support (sendTo) to exhibit new commands (snooze #294, chime, quickResponse, getQuickResponseVoices, pollRefresh)
* (bropat) Fixed deletion of obsolete devices, channels and states
* (bropat) Added support for Video Smart Lock S330 (T8530)
* (bropat) Added support for Smart Lock C210 (T8502)
* (bropat) Added support for Smart Lock C220 (T8506)
* (bropat) Added support for Smart Lock S230 (T8510P)
* (bropat) Added support for Smart Lock S231 (T8520P)
* (bropat) Added support for Retrofit Smart Lock E110 (T8503)
* (bropat) Added support for Retrofit Smart Lock E130 (T8504)
* (bropat) Added support for Smart Drop S300 (T8790)
* (bropat/martijnpoppen) Added support for Video Doorbell E340 (T8214)
* (martijnpoppen) Added support for MiniBase Chime (T8023)
* (bropat/martijnpoppen) Added support for eufyCam E330 (Professional; T8600; #391)
* (bropat/martijnpoppen) Added support for Solar Wall Light Cam S120 (T84A0; #406)
* (bropat/martijnpoppen) Added support for SoloCam S340 (T8170; #399)
* (bropat) Added support for Indoor Cam S350 (T8416; #403)
* (bropat) Added support for Floodlight Cam E340 (T8425, #428)
* (bropat) Added support for SoloCam C210 (T8B00)
* (bropat) Storage of files switched to [Meta-Storage](https://iobroker.readthedocs.io/de/latest/bestpractice/storefiles.html#meta-storage)
* (bropat) Implemented workaround for livestreaming issue introduced by CVE-2023-46809 in Node.js (18.19.1=<; 20.11.1=<; 21.6.2=<)
* (bropat) Changed ffmpeg static package from `ffmpeg-static` to `ffmpeg-for-homebridge`
* (bropat) Fixed issue #432
* (bropat) Fixed issue #422
* (bropat) Fixed issue #420
* (bropat) Fixed issue #387
* (bropat) Fixed issue #380
* (bropat) Fixed issue #379
* (bropat) Fixed issue #376
* (bropat) Fixed issue #371
* (bropat) Updated version of the package go2rtc-static (1.8.5)
* (bropat) Updated version of the package eufy-security-client (3.0.0)
* (bropat) Further details can be found in the changelog of eufy-security-client (3.0.0)

## 1.2.1 (2023-11-04)

* (bropat) Updated version of the package eufy-security-client (2.9.1)
* (bropat) Further details can be found in the changelog of eufy-security-client (2.9.1)

## 1.2.0 (2023-11-04)

* (bropat) Requires node version >= 18
* (bropat) Added support for SmartTrack Link (T87B0) and SmartTrack Card (T87B2)
* (bropat) Added support for SoloCam S220 (T8134)
* (bropat) Fixed livestream issue
* (bropat) Updated version of the package go2rtc-static (1.8.1)
* (bropat) Updated version of the package eufy-security-client (2.9.0)
* (bropat) Further details can be found in the changelog of eufy-security-client (2.9.0)

## 1.1.2 (2023-08-31)

* (bropat) Updated version of the package eufy-security-client (2.8.1)
* (bropat) Further details can be found in the changelog of eufy-security-client (2.8.1)

## 1.1.1 (2023-08-20)

* (bropat) Fixed issue #365
* (bropat) Fixed issue #363
* (bropat) Updated version of the package ffmpeg-static (5.2.0)
* (bropat) Updated version of the package eufy-security-client (2.8.0)
* (bropat) Further details can be found in the changelog of eufy-security-client (2.8.0)

## 1.1.0 (2023-08-08)

* (bropat) Added support for Wired Wall Light Cam S100 (T84A1; #332)
* (bropat) Added support for Garage-Control Cam (T8452)
* (bropat) Fixed issue #353
* (bropat) Fixed issue #347
* (bropat) Fixed issue #342
* (bropat) Fixed issue #316
* (bropat) Updated version of the package go2rtc-static (1.6.2)
* (bropat) Updated version of the package eufy-security-client (2.7.1)
* (bropat) Further details can be found in the changelog of eufy-security-client (2.7.1)

## 1.0.0 (2023-05-16)

* (bropat) Notification pictures are supported again
* (bropat) Implemented new livestream support using go2rtc (WebRTC/MSE, rtsp)
* (bropat) Fixed issue #323
* (bropat) Updated version of the package eufy-security-client (2.6.2)
* (bropat) Further details can be found in the changelog of eufy-security-client (2.6.2)

**Note:** The download of event videos has been temporarily removed as decryption of these is not yet supported. It will be added back as soon as it is supported.

## 0.9.10 (2023-02-24)

* (bropat) Requires node version >= 16
* (bropat) Fixed issue #319
* (bropat) Fixed issue #307
* (bropat) Fixed issue #306
* (bropat) Fixed issue #305
* (bropat) Updated version of the package eufy-security-client (2.4.2)
* (bropat) Further details can be found in the changelog of eufy-security-client (2.4.2)

**Note:** The download of notification images has been temporarily removed as decryption of these is not yet supported. It will be added back as soon as it is supported.

## 0.9.9 (2022-12-24)

* (bropat) Fixed issue #311
* (bropat) Fixed issue #312
* (bropat) Updated version of the package eufy-security-client (2.4.0)
* (bropat) Further details can be found in the changelog of eufy-security-client (2.4.0)

## 0.9.8 (2022-11-26)

* (bropat) Fixed issue #300
* (bropat) Updated version of the package eufy-security-client (2.3.0)
* (bropat) Further details can be found in the changelog of eufy-security-client (2.3.0)

**Note:** Those who use 2FA will be prompted to do so again after this update.

## 0.9.7 (2022-11-12)

* (bropat) Implemented Homebase Alarm (#271)
* (bropat) Fixed issue #293
* (bropat) Updated version of the package eufy-security-client (2.2.3)
* (bropat) Further details can be found in the changelog of eufy-security-client (2.2.3)

## 0.9.6 (2022-11-06)

* (bropat) Fixed issue #292
* (bropat) Updated version of the package eufy-security-client (2.2.2)
* (bropat) Further details can be found in the changelog of eufy-security-client (2.2.2)

## 0.9.5 (2022-11-05)

* (bropat) Added new P2P feature: unlock smart safe products
* (bropat) Added option to enable/disable "Automatically download picture" (#255)
* (bropat) Fixed issue #269
* (bropat) Updated version of the package eufy-security-client (2.2.1)
* (bropat) Further details can be found in the changelog of eufy-security-client (2.2.1)

## 0.9.4 (2022-07-30)

* (bropat) Updated version of the package eufy-security-client (2.1.2)
* (bropat) Further details can be found in the changelog of eufy-security-client (2.1.2)

## 0.9.3 (2022-07-16)

* (bropat) Updated version of the package eufy-security-client (2.1.1)
* (bropat) Further details can be found in the changelog of eufy-security-client (2.1.1)

## 0.9.2 (2022-06-12)

* (bropat) Updated version of the package eufy-security-client (2.1.0)
* (bropat) Further details can be found in the changelog of eufy-security-client (2.1.0)

## 0.9.1 (2022-05-03)

* (bropat) Updated version of the package eufy-security-client (2.0.1)
* (bropat) Further details can be found in the changelog of eufy-security-client (2.0.1)

## 0.9.0 (2022-04-30)

* (bropat) Requires node version >= 14.17
* (bropat) Added support for Battery Doorbell Dual (T8213)
* (bropat) Added support for Video Doorbell Dual (T8203)
* (bropat) Added support for IndoorCam Mini (T8414)
* (bropat) Fixed issue #250
* (bropat) Fixed issue #238
* (bropat) Fixed issue #236
* (bropat) Fixed issue #231
* (bropat) Fixed issue #229
* (bropat) Fixed issue #208
* (bropat) Updated version of the package eufy-security-client (2.0.0)
* (bropat) Further details can be found in the changelog of eufy-security-client (2.0.0)

## 0.8.5 (2022-02-12)

* (bropat) Fixed issue #222
* (bropat) Updated version of the package eufy-security-client (1.6.6)
* (bropat) Further details can be found in the changelog of eufy-security-client (1.6.6)

## 0.8.4 (2022-02-08)

* (bropat) Fixed regression in authentication flow
* (bropat) Fixed issue #228
* (bropat) Updated version of the package eufy-security-client (1.6.5)
* (bropat) Further details can be found in the changelog of eufy-security-client (1.6.5)

## 0.8.3 (2022-02-07)

* (bropat) Updated version of the package eufy-security-client (1.6.4)
* (bropat) Further details can be found in the changelog of eufy-security-client (1.6.4)
* (bropat) Fixed issue #222
* (bropat) Fixed issue #224
* (bropat) Fixed issue #225

**Note:** Selecting the correct country in ioBroker is essential for the devices to be found (should match the setting in the Eufy app).

## 0.8.2 (2022-02-06)

* (bropat) Renamed Adapter to ioBroker.euSec
* (bropat) Updated version of the package eufy-security-client (1.6.3)
* (bropat) Further details can be found in the changelog of eufy-security-client (1.6.3)
* (bropat) Fixed issue #221

## 0.8.1 (2022-02-05)

* (bropat) Fixed MQTT connection issue (error: 5; #219)
* (bropat) Updated version of the package eufy-security-client (1.6.2)
* (bropat) Further details can be found in the changelog of eufy-security-client (1.6.2)

## 0.8.0 (2022-02-05)

* (bropat) Added support for Smart Lock Touch & Wifi (T8520; #138)
* (bropat) Added option to enable/disable "Automatically download video" (#180; #203)
* (bropat) Added new state to retrieve received captcha in HTML format "received_captcha_html" (#210)
* (bropat) Updated version of the package eufy-security-client (1.6.1)
* (bropat) Further details can be found in the changelog of eufy-security-client (1.6.1)
* (bropat) Updated versions of the package dependencies
* (bropat) Fixed issue #199
* (bropat) Fixed issue #217
* (bropat) Some other small bugfixes

## 0.7.5 (2021-12-05)

* (bropat) Fixed issue #195
* (bropat) Fixed issue #202

## 0.7.4 (2021-11-22)

* (bropat) Implemented captcha authentication mechanism (API v2)
* (bropat) Updated version of the package eufy-security-client (1.4.0)

## 0.7.3 (2021-11-20)

* (bropat) Implemented new encrypted authentication mechanism (API v2)
* (bropat) Dropped old plaintext authentication mechanism (API v1)
* (bropat) Fixed issue #191
* (bropat) Updated version of the package eufy-security-client (1.3.0)

**Note:** If you have 2FA enabled, you will need to authenticate again after this update.

## 0.7.2 (2021-11-16)

* (bropat) Updated version of the package eufy-security-client (1.2.3)
* (bropat) Further details can be found in the changelog of eufy-security-client (1.2.3)
* (bropat) Changed ioBroker.admin dependency to ">=4.0.10"
* (bropat) Updated versions of the package dependencies

## 0.7.1 (2021-10-23)

* (bropat) Updated version of the package eufy-security-client (1.2.1)
* (bropat) Further details can be found in the changelog of eufy-security-client (1.2.1)

## 0.7.0 (2021-10-17)

* (bropat) Added support for Floodlight T8422
* (bropat) Added support for SoloCam E40 (T8131)
* (bropat) Added new properties for solo cameras: battery, batteryTemperature, wifiSignalLevel, state, chargingStatus, lastChargingDays, lastChargingRecordedEvents, lastChargingTotalEvents, batteryUsageLastWeek
* (bropat) Fixed issue #169
* (bropat) Fixed issue #167
* (bropat) Fixed issue #151
* (bropat) Fixed push notifications for solo cameras (motion and person detection)
* (bropat) Updated version of the package eufy-security-client (1.2.0)
* (bropat) Updated versions of the package dependencies
* (bropat) Further details can be found in the changelog of eufy-security-client (1.2.0)

## 0.6.2 (2021-08-19)

* (bropat) Updated version of the package eufy-security-client (1.1.2)

## 0.6.1 (2021-08-19)

* (bropat) Fixed issue in the function responsible for the version upgrade (non-updatable states; issue #159)
* (bropat) Tried to fix issue #157 and issue #140

## 0.6.0 (2021-08-13)

* (bropat) **Breaking Changes** Switched to the new managed driver class - All states will be dropped and recreated (Note: some states where renamed)
* (bropat) Supports Admin 5
* (bropat) Added new adapter setting "Accept incoming invitations" to automatically accept device invitations
* (bropat) Added new adapter setting "Alarm sound duration (sec)" used for triggering alarm sound on supported devices/stations ([#76](https://github.com/bropat/ioBroker.euSec/issues/76))
* (bropat) Added enable/disable led setting for camera 1 products
* (bropat) Added motion detection sensitivity setting for camera 1 products and wired doorbell
* (bropat) Added motion detection type setting for camera 1 products
* (bropat) Added motion audio recording setting for camera 1 products and wired doorbell
* (bropat) Added ringtone volume setting for wired doorbell
* (bropat) Added enable/disable indoor chime setting for wired doorbell ([#100](https://github.com/bropat/ioBroker.euSec/issues/100))
* (bropat) Added notification ring setting for wired doorbell
* (bropat) Added notification motion setting for wired doorbell
* (bropat) Added video streaming quality setting for wired doorbell
* (bropat) Added video recording quality setting for wired doorbell
* (bropat) Added video HDR setting for wired doorbell
* (bropat) Added video distortion correction setting for wired doorbell
* (bropat) Added video ring recording setting for wired doorbell
* (bropat) Added notification type setting for camera 1 products, solo cameras and wired doorbell
* (bropat) Added chirp volume setting for entry sensor
* (bropat) Added chirp tone setting for entry sensor
* (bropat) Added pan an tilt functionality to supported indoor cameras ([#129](https://github.com/bropat/ioBroker.euSec/issues/129))
* (bropat) Added error detection if stopping or starting stream that isn't running or already running
* (bropat) Added new setting "acceptInvitations" to "EufySecurity" to accept invitations automatically
* (bropat) Added floodlight camera light switch ([#133](https://github.com/bropat/ioBroker.euSec/issues/133))
* (bropat) Added motion detection sensitivity for indoor cameras, solo cameras, floodlight cameras, camera 2 products and battery doorbells ([#133](https://github.com/bropat/ioBroker.euSec/issues/133))
* (bropat) Added motion detection type for indoor cameras, solo cameras, floodlight cameras, camera 2 products and battery doorbells ([#133](https://github.com/bropat/ioBroker.euSec/issues/133))
* (bropat) Added motion tracking for indoor camera pan & tilt cameras
* (bropat) Added video stream quality setting for indoor cameras, solo cameras, floodlight cameras and battery doorbell ([#133](https://github.com/bropat/ioBroker.euSec/issues/133))
* (bropat) Added video recording quality setting for indoor cameras
* (bropat) Added WDR setting for battery doorbells
* (bropat) Added microphone mute setting for indoor cameras, solo cameras, floodlight cameras, camera 2 products and battery doorbells ([#133](https://github.com/bropat/ioBroker.euSec/issues/133))
* (bropat) Added audio recording setting for indoor cameras, solo cameras, floodlight cameras, camera 2 products and battery doorbells ([#133](https://github.com/bropat/ioBroker.euSec/issues/133))
* (bropat) Added enable/disable speaker setting for indoor cameras, solo cameras, floodlight cameras, camera 2 products ([#133](https://github.com/bropat/ioBroker.euSec/issues/133))
* (bropat) Added speaker volume setting for indoor cameras, solo cameras, floodlight cameras, camera 2 products and battery doorbells ([#133](https://github.com/bropat/ioBroker.euSec/issues/133))
* (bropat) Added power source setting for camera 2 products cameras, eufy cameras and eufy E cameras
* (bropat) Added power working mode setting for solo cameras, camera 2 products, battery doorbells, eufy cameras and eufy E cameras
* (bropat) Added power custom working mode recording clip length setting for solo cameras, floodlight cameras, camera 2 products, battery doorbells, eufy cameras and eufy E cameras ([#133](https://github.com/bropat/ioBroker.euSec/issues/133))
* (bropat) Added power custom working mode recording retrigger interval setting for solo cameras, floodlight cameras, camera 2 products, battery doorbells, eufy cameras and eufy E cameras ([#133](https://github.com/bropat/ioBroker.euSec/issues/133))
* (bropat) Added power custom working mode recording ends if motion stops setting for solo cameras, floodlight cameras, camera 2 products, battery doorbells, eufy cameras and eufy E cameras ([#133](https://github.com/bropat/ioBroker.euSec/issues/133))
* (bropat) Added video streaming quality setting for indoor cameras, solo cameras, floodlight cameras, 2c pro cameras and battery doorbells ([#133](https://github.com/bropat/ioBroker.euSec/issues/133))
* (bropat) Added video recording quality setting for indoor 2k cameras and 2c pro cameras
* (bropat) Added motion detection sensitivity setting for indoor cameras, floodlight cameras and camera 2 products ([#133](https://github.com/bropat/ioBroker.euSec/issues/133))
* (bropat) Added enable/disable motion tracking setting for indoor pan & tilt cameras
* (bropat) Added motion detection type setting for indoor cameras, solo cameras, floodlight cameras, camera 2 products and battery doorbells ([#133](https://github.com/bropat/ioBroker.euSec/issues/133))
* (bropat) Added enable/disable WDR setting for battery doorbells
* (bropat) Added ringtone volume setting for battery doorbells
* (bropat) Added enable/disable chime indoor setting for battery doorbells ([#100](https://github.com/bropat/ioBroker.euSec/issues/100))
* (bropat) Added enable/disable chime homebase setting for battery doorbells ([#100](https://github.com/bropat/ioBroker.euSec/issues/100))
* (bropat) Added chime homebase ringtone volume setting for battery doorbells
* (bropat) Added chime homebase ringtone type setting for battery doorbells
* (bropat) Added notification type setting for solo cameras, floodlight cameras, camera 2 products, battery doorbells, eufy cameras and eufy E cameras ([#133](https://github.com/bropat/ioBroker.euSec/issues/133))
* (bropat) Added enable/disable person notification setting for indoor cameras
* (bropat) Added enable/disable pet notification setting for indoor cameras
* (bropat) Added enable/disable all other motion notification setting for indoor cameras
* (bropat) Added enable/disable all sound notification setting for indoor cameras
* (bropat) Added enable/disable crying notification setting for indoor cameras
* (bropat) Added enable/disable motion notification setting for battery doorbells
* (bropat) Added enable/disable ring notification setting for battery doorbells
* (bropat) Added trigger alarm sound for camera 2 products, indoor cameras, solo cameras (incl. new) and floodlight cameras ([#76](https://github.com/bropat/ioBroker.euSec/issues/76))
* (bropat) Added reset alarm sound for camera 2 products, indoor cameras, solo cameras (incl. new) and floodlight cameras ([#76](https://github.com/bropat/ioBroker.euSec/issues/76))
* (bropat) Added trigger alarm sound for homebase 1+2 ([#76](https://github.com/bropat/ioBroker.euSec/issues/76))
* (bropat) Added reset alarm sound for homebase 1+2 ([#76](https://github.com/bropat/ioBroker.euSec/issues/76))
* (bropat) Added alarm tone setting for homebase 1+2
* (bropat) Added alarm volume setting for homebase 1+2
* (bropat) Added prompt volume setting for homebase 1+2
* (bropat) Added time format setting for homebase 1+2
* (bropat) Added enable/disable switch mode app notification setting for homebase 1+2
* (bropat) Added enable/disable switch mode geofence notification setting for homebase 1+2
* (bropat) Added enable/disable switch mode schedule notification setting for homebase 1+2
* (bropat) Added enable/disable switch mode keypad notification setting for homebase 1+2
* (bropat) Added enable/disable start alarm delay notification setting for homebase 1+2
* (bropat) Added new floodlight, solo and outdoor cameras (untested!)
* (bropat) Added brightness light setting for 2c/2c pro cameras, new solo cameras and new outdoor cameras
* (bropat) Added enable/disable light setting for 2c/2c pro cameras, new solo cameras and new outdoor cameras
* (bropat) Added battery charging state for keypad devices
* (bropat) Added wifi rssi state for keypad devices
* (bropat) Added nightvision setting for devices supporting the "light" nightvision mode
* (bropat) Added enable disable "switch mode with access code" for station with registered keypad
* (bropat) Added enable disable "auto end alarm" for station with registered keypad
* (bropat) Added enable disable "turn off alarm with button" for station with registered keypad
* (bropat) Fixed issue [#98](https://github.com/bropat/ioBroker.euSec/issues/98)
* (bropat) Fixed issue [#140](https://github.com/bropat/ioBroker.euSec/issues/140)
* (bropat) Fixed issue [#146](https://github.com/bropat/ioBroker.euSec/issues/146)
* (bropat) Fixed issue [#117](https://github.com/bropat/ioBroker.euSec/issues/117)
* (bropat) Many small bugfixes
* (bropat) Updated versions of the package dependencies

## 0.5.5 (2021-06-01)

* (bropat) Fixed regression in p2p protocol

## 0.5.4 (2021-05-26)

* (bropat) Fixed issue with video corruption in p2p livestream
* (bropat) Updated versions of the package dependencies

## 0.5.3 (2021-05-14)

* (bropat) Fixed issue [#121](https://github.com/bropat/ioBroker.euSec/issues/121)
* (bropat) Fixed push notification for indoor and floodlight cams (issue [#130](https://github.com/bropat/ioBroker.euSec/issues/130))
* (bropat) Fixed refresh of properties/settings of standalone devices (issue [#130](https://github.com/bropat/ioBroker.euSec/issues/130))
* (bropat) Updated versions of the package dependencies

## 0.5.2 (2021-04-02)

* (bropat) Try to add support for FreeBSD - issue [#106](https://github.com/bropat/ioBroker.euSec/issues/106)
* (bropat) Updated package dependency ffmpeg-static for FreeBSD support

## 0.5.1 (2021-04-01)

* (bropat) Fixed issue [#105](https://github.com/bropat/ioBroker.euSec/issues/105)

## 0.5.0 (2021-03-30)

* (bropat) Added support for smart lock products
* (bropat) Added new P2P feature: lock/unlock smart lock products
* (bropat) Optimized speed of P2P connection establishment
* (bropat) New setting: P2P connection setup preference: local prefered, local only or quickest connection
* (bropat) Dropped support for NodeJS 10.x (min. requirement 12)
* (bropat) Updated versions of the package dependencies

## 0.4.3 (2021-03-19)

* (bropat) Code enhancements for publishing the adapter to the central repository
* (bropat) Updated versions of the package dependencies

## 0.4.2 (2021-03-14)

* (bropat) Fixed roles of states according to ioBroker documentation

## 0.4.1 (2021-03-14)

* (bropat) Removed legacy password encryption support for admin adapter (requires admin adapter >= 4.0.9)
* (bropat) Added admin adapter as global dependency
* (bropat) Updated license

## 0.4.0 (2021-03-11)

* (bropat) Added handling of adapter updates with breaking changes
* (bropat) Added new P2P feature: enable/disable pet detection for indoor cameras
* (bropat) Added new P2P feature: enable/disable sound detection for indoor cameras
* (bropat) Added new P2P feature: enable/disable led for wired doorbell
* (bropat) Unlocked state: last_event_video_url
* (bropat) Fixed parsing of push notification to download video events for battery doorbells and indoor cameras
* (bropat) Fixed enable/disable device (for wired doorbells, indoor cameras, floodlight camera and solo cameras)
* (bropat) Fixed enable/disable led (for battery doorbells, indoor cameras, floodlight camera and solo cameras)
* (bropat) Fixed enable/disable motion detection (for indoor cameras, floodlight camera and solo cameras)
* (bropat) Fixed change video watermark setting (for indoor cameras and floodlight camera)
* (bropat) Updated versions of the package dependencies

## 0.3.1 (2021-03-06)

* (bropat) Fixed regression on livestream with h265 codec

## 0.3.0 (2021-03-05)

* (bropat) Implemented feature request [#88](https://github.com/bropat/ioBroker.euSec/issues/88): Enable/disable motion detection for camera products
* (bropat) Implemented feature request [#81](https://github.com/bropat/ioBroker.euSec/issues/81): Enable/disable RTSP stream (added also RTSP stream url)
* (bropat) Implemented asynchronous download of event videos when receiving a push notification
* (bropat) Optimized ffmpeg implementation to only muxing video data to HLS
* (bropat) Optimized HLS livestream video start delay (10-15 sec.)
* (bropat) Fixed possible race condition with ffmpeg when using fallback to Eufy RTMP live stream
* (bropat) Fixed issue with livestream when p2p connection is lost
* (bropat) Updated versions of the package dependencies

## 0.2.5 (2021-02-20)

* (bropat) Fixed possible race condition that brokes sometime the livestream
* (bropat) Updated versions of the package dependencies

## 0.2.4 (2021-02-20)

* (bropat) Fixed issue [#86](https://github.com/bropat/ioBroker.euSec/issues/86)
* (bropat) Fixed not correctly identifying if the livestream is still active or not

## 0.2.3 (2021-02-17)

* (bropat) Fixed wired doorbell p2p livestream (should fix also indoor, floodlight and solo cameras)
* (bropat) Fixed issue that treats known push notifications as unknown
* (bropat) Fixed relative path for state last_event_pic_url
* (bropat) Updated versions of the package dependencies

## 0.2.2 (2021-02-16)

* (bropat) Fixed web extension settings for serving videos and pictures (issue [#79](https://github.com/bropat/ioBroker.euSec/issues/78))

## 0.2.1 (2021-02-15)

* (bropat) Fixed device_enable state
* (bropat) Fixed battery doorbell start livestream over p2p (issue [#78](https://github.com/bropat/ioBroker.euSec/issues/78))
* (bropat) Implemented fallback for failed P2P livestream to RTMP livestream

## 0.2.0 (2021-02-14)

* (bropat) Implemented P2P livestream over HLS
* (bropat) Last livestream is always saved and is still available later
* (bropat) Implemented device and station parameter refresh over P2P
* (bropat) Revised push notification implementation
* (bropat) Fixed issue [#71](https://github.com/bropat/ioBroker.euSec/issues/71) by implementing retry mechanism on HTTP error 404 (max. 5 retries with increasing delay)
* (bropat) Fixed issue [#12](https://github.com/bropat/ioBroker.euSec/issues/12)
* (bropat) Eufy client library extracted as standalone library and adapters ported to new shared library: [eufy-security-client](https://www.npmjs.com/package/eufy-security-client)
* (bropat) Removed following states: last_captured_pic_url, last_captured_pic_html
* (bropat) Updated versions of the package dependencies

## 0.1.5 (2021-01-14)

* (bropat) Fixed issue [#50](https://github.com/bropat/ioBroker.euSec/issues/50) and [#53](https://github.com/bropat/ioBroker.euSec/issues/53)
* (bropat) Updated versions of the package dependencies

## 0.1.4 (2021-01-05)

* (bropat) Fixed: Accept only valid modes for station guard mode (for invalid mode, an error is logged)
* (bropat) Fixed reset of an event (motion, ringing, etc.)
* (bropat) Updated versions of the package dependencies

## 0.1.3 (2021-01-02)

* (bropat) Fixed issue [#37](https://github.com/bropat/ioBroker.euSec/issues/37) and [#41](https://github.com/bropat/ioBroker.euSec/issues/41)
* (bropat) Updated versions of the package dependencies

## 0.1.2 (2021-01-02)

* (bropat) Revised captured_pic_url state (renamed to last_captured_pic_url and added last_captured_pic_html)
* (bropat) Fixed p2p issue passing wrong user id (action_user_id instead of admin_user_id)
* (bropat) Revised push notification to properly support doorbell notifications
* (bropat) Updated versions of the package dependencies

## 0.1.1 (2020-12-29)

* (bropat) Fixed issue [#37](https://github.com/bropat/ioBroker.euSec/issues/37)
* (bropat) Fixed version numbering
* (bropat) Updated versions of the package dependencies

## 0.0.9 (2020-12-28)

* (bropat) Finished implementation for feature request: [#1](https://github.com/bropat/ioBroker.euSec/issues/1)
* (bropat) Little progress for feature request: [#5](https://github.com/bropat/ioBroker.euSec/issues/5)
* (bropat) Now supports also cloud P2P communication if local P2P comunication isn't possible
* (bropat) Implemented set Guard Mode with CMD_SET_PAYLOAD for certain devices
* (bropat) Added back USA ip addresses for P2P cloud discovery
* (bropat) Using the correct local time zone for communication with the Eufy Cloud
* (bropat) HUB filtering by device type 0 (station) removed
* (bropat) Added documentation for 2FA
* (bropat) Updated versions of the package dependencies

## 0.0.8 (2020-12-13)

* (bropat) Fixed issue [#16](https://github.com/bropat/ioBroker.euSec/issues/16)
* (bropat) P2P communication revisited
* (bropat) Added reconnect functionality for P2P communication
* (bropat) Added heartbeat for P2P communication
* (bropat) Added local caching of last event picture as image url or html image (removed old state: last_camera_url)
* (bropat) Updated versions of the package dependencies

## 0.0.7 (2020-12-08)

* (bropat) Fixed issue [#11](https://github.com/bropat/ioBroker.euSec/issues/11)

## 0.0.6 (2020-12-06)

* (bropat) Fixed issue [#13](https://github.com/bropat/ioBroker.euSec/issues/13)

## 0.0.5 (2020-12-05)

* (bropat) Added event states for camera (motion detected, person detected)
* (bropat) Added event states for entry sensor (open/closed)
* (bropat) Added event states for motion sensor (motion detected)
* (bropat) Added event states for doorbell (motion detected, person detected, ringing)
* (bropat) Added event states for indoor camera (motion detected, person detected, crying detected, sound detected, pet detected)
* (bropat) Added entry sensor state (online, offline, etc.)
* (bropat) Added entry sensor low battery
* (bropat) Added motion sensor state (online, offline, etc.)
* (bropat) Added motion sensor low battery
* (bropat) Added keypad state (online, offline, etc.)
* (bropat) Added keypad low battery

## 0.0.4 (2020-12-03)

* (bropat) Better exception handling
* (bropat) Fixed push token handling
* (bropat) Added push connection retry mechanism
* (bropat) Added camera state (online, offline, etc.)
* (bropat) Added camera wifi RSSI
* (bropat) Added camera total events since last charge
* (bropat) Added camera saved/recorded events since last charge
* (bropat) Added camera filtered false events since last charge
* (bropat) Added camera used days since last charge
* (bropat) Added camera battery temperature

## 0.0.3 (2020-11-21)

* (bropat) Fixed issue with push notification credentials initialization

## 0.0.2 (2020-11-21)

* (bropat) Added push notification support for event notification (raw notifications!)
* (bropat) Added 2FA (token renewal needs manual intervention)
* (bropat) Added P2P communication with station (event: Alarm mode change)
* (bropat) Added more device classes (sensors, locks, keypads) with no actions (at the moment! WIP!)
* (bropat) Added all eufy camera devices release to date
* (bropat) Added battery state to eufy cameras

## 0.0.1 (2020-10-04)

* (bropat) initial release
