![Logo](docs/_media/ioBroker.euSec.png)
# ioBroker.euSec

[![NPM version](https://img.shields.io/npm/v/iobroker.eusec.svg)](https://www.npmjs.com/package/iobroker.eusec)
[![Downloads](https://img.shields.io/npm/dm/iobroker.eusec.svg)](https://www.npmjs.com/package/iobroker.eusec)
[![Total Downloads](https://img.shields.io/npm/dt/iobroker.eusec.svg)](https://www.npmjs.com/package/iobroker.eusec)
![Node version requirement](https://img.shields.io/node/v/iobroker.eusec)
![Number of Installations (latest)](https://iobroker.live/badges/eusec-installed.svg)
![Number of Installations (stable)](https://iobroker.live/badges/eusec-stable.svg)
[![Dependency Status](https://img.shields.io/librariesio/release/npm/iobroker.eusec)](https://libraries.io/npm/iobroker.eusec)

**Tests:** ![Test and Release](https://github.com/iobroker-community-adapters/ioBroker.eusec/workflows/Test%20and%20Release/badge.svg)

[![NPM](https://nodei.co/npm/iobroker.eusec.png?downloads=true)](https://nodei.co/npm/iobroker.eusec/)

> [!IMPORTANT]
> This adapter cannot be installed from github


This is an [ioBroker](https://www.iobroker.net) adapter that uses the [eufy-security-client](https://github.com/bropat/eufy-security-client) library to communicate with Eufy devices.

**This project is not affiliated with Anker and Eufy (Eufy Security). It is a personal project that is maintained in spare time.**

## Description

This adapter allows you to control [Eufy security devices](https://us.eufylife.com/collections/security) by connecting to the Eufy cloud servers and local/remote stations.

You need to provide your Cloud login credentials. The adapter connects to your cloud account and polls for all device data via HTTPS. Now a local or remote P2P connection to the Eufy stations/devices is also supported. However, a connection to the Eufy Cloud is always a prerequisite.

One Adapter instance will show all devices from one Eufy Cloud account and allows you to control them.

## Documentation

Check out the documentation [here](https://github.com/iobroker-community-adapters/ioBroker.eusec/tree/master/docs).

## Known working devices

Information about supported devices can be found [here](https://github.com/iobroker-community-adapters/ioBroker.eusec/blob/master/docs/devices.md).

## Credits

This adapter would not have been possible without the great work of Patrick Broetto (brobat) <https://github.com/bropat>, who created previous releases of this adapter.

## Upgrading from adapter 2.x or older

Adapter 2.x and older added `--security-revert=CVE-2023-46809` to the node process parameters of every instance running on node.js 18 or 20. node.js 22 and newer refuse to start an instance with that flag, and this adapter requires node.js 24.

Updating this adapter clears the node process parameters of all eusec instances, which removes the flag. Other parameters (e.g. `--max-old-space-size`) are cleared as well and have to be entered again after each update. If an instance still does not start and its log shows `--security-revert=CVE-2023-46809`, remove the parameters by hand and restart the instance:

```
iobroker object set system.adapter.eusec.0 common.nodeProcessParams=[]
```

A detailed description (in German) is available at our forum (https://forum.iobroker.net/topic/82651/test-adapter-eusec-v2-0-x).

## Changelog

<!--
	Placeholder for the next version (at the beginning of the line):
	### **WORK IN PROGRESS**
-->
### 3.6.0 (2026-10-25)
- (typhosj) eufyCam C37 (T814X): the states `dualCamWatchViewMode` and `enabled` are no longer created and are removed from existing installations. The C37 has one lens and does not report whether it is enabled, so `enabled` always showed `true` (#198)
- (typhosj) Compatibility streams no longer stop answering for good after a viewer left. The bundled go2rtc 1.9.4 could lock up a transcoded stream when it ended it, and only a restart of the adapter helped. The adapter now downloads go2rtc 1.9.14 from its GitHub release once, checks it against the published checksum and keeps it in the data directory of the instance. Without access to GitHub it falls back to go2rtc 1.9.4 and logs a warning
- (typhosj) The setting "Livestream quality" now also applies to cameras that name their qualities by resolution, such as the SoloCam S340 or the Indoor Cam S350. Low, medium and high stand for the lowest, the second and the third resolution, for example 720P, 1080P and 3K. Until now these cameras stayed at "Auto", where they change the resolution while the livestream runs and the player shows a green or black picture. The SoloCam S340 raises its resolution at the start of every livestream even at a fixed quality; for it, a compatibility stream keeps the resolution steady (reported in the forum)
- (typhosj) New setting "Excluded devices": the instance ignores the devices and stations listed there. It creates no states for them, receives none of their events and pictures and does not connect to them; excluding a HomeBase excludes every device connected to it. Useful when two ioBroker installations share one Eufy account, for example one at home and one in a motorhome on mobile data (requested in the forum)
- (typhosj) Compatibility streams play sound in VLC again. The transcoded picture started 2 to 4 seconds ahead of the sound, so VLC dropped the sound, while browsers still played it. The video now keeps the timestamps the camera sent (reported in the forum)

### 3.5.0 (2026-10-11)
- (hdering) The eufyCam C37 (T814X) is no longer an unknown device without states: the adapter handles it like the eufyCam S4. Livestream, motion, person and vehicle detection, light, pan and tilt and the battery states should work, but are not confirmed on a real camera yet - please report in #198

### 3.4.2 (2026-10-05)
- (typhosj) On-demand livestreams no longer show only a picture every few seconds and then go black. Since 3.4.0 every keyframe of 16 KB or more was taken for a go2rtc that does not keep up, and the video up to the next keyframe was dropped. Data is now only dropped once more than 4 MB wait for go2rtc (reported in the forum)

### 3.4.1 (2026-10-05)
- (typhosj) Updating the adapter clears the node process parameters of all eusec instances again, which removes `--security-revert=CVE-2023-46809` left over from adapter 2.x. The install script that removed only this flag is gone, since install scripts are not allowed for ioBroker adapters. Other parameters such as `--max-old-space-size` have to be entered again after each update

### 3.4.0 (2026-10-02)
- (typhosj) Floodlight Cam E30 (T8426): preset positions are now sent to the camera (before, writing `preset_position`, `save_preset_position` or `delete_preset_position` had no effect), and the livestream is no longer rejected with `ERROR_INVALID_ACCOUNT`. The camera now gets the commands of the Floodlight Cam E340, which the library already defines it like (reported in the forum)
- (hdering) **Changed URLs:** without a configured host name, the livestream URLs (states `livestream`, `livestream_rtsp`) now use the IPv4 address in the LAN of the ioBroker host the instance runs on instead of the name of the first ioBroker host (e.g. `http://192.168.1.10:1984/...` instead of `http://iobroker:1984/...`). Tablets, phones and dashboards often cannot resolve the name, and with several hosts the first one is not necessarily the one that runs go2rtc. Visualizations and scripts that store the URL get the new one with the next livestream; to keep a name, enter it in the setting "Hostname"
- (hdering) New setting "Start livestreams on demand": the livestream of a camera starts as soon as its player page or RTSP URL is opened and stops shortly after the last viewer left, so `start_stream` is no longer needed and a dashboard shows a picture right away. A livestream that ends at the maximum duration is started again while somebody still watches. A station carries one livestream at a time: while one of its cameras is watched, the player of another one says which camera that is and starts by itself once the station is free, and a paused player releases the station. Starts the camera acknowledges without sending anything are retried. The states `livestream` and `livestream_rtsp` always carry the URL in this mode. go2rtc's player page and API port have no authentication, so every device in the network that reaches them can wake the cameras. Off by default
- (hdering) New tab "Streams" in the instance settings: every device with a livestream with its station, the player URL to open and the RTSP URL - no need to look the streams up in go2rtc anymore
- (hdering) New setting "Livestream quality": sets the streaming quality of every camera to low, medium or high before its livestream starts, so no camera streams at "Auto", where it changes the resolution mid-stream and browsers show a green or frozen picture. The encoding of battery doorbells ("Medium / Low Encoding") is kept, devices that name their qualities by resolution ("1080P", "2K HD") are left alone. Off by default. The warning about the "Auto" quality is now logged once per device instead of at every livestream start, and names the state to change and the fixed qualities the device offers
- (hdering) New setting "Wait for camera data (sec)", 15 seconds by default: a livestream is no longer given up after 5 seconds without data. Battery cameras that first have to wake up often need longer, and their livestream then ended with "we haven't received any data for 5 seconds" before the first frame
- (hdering) The maximum livestream duration counts from the first picture instead of from the start command, so a camera that needs a minute to wake up no longer loses that minute of its livestream
- (hdering) Livestream: the audio track (or, with a slow camera, the whole stream) no longer breaks after 5 seconds with `socket hang up`. go2rtc drops connections whose request header does not arrive within 5 seconds, and the adapter only sent it with the first data. A livestream that already ended is no longer stopped a second time, which logged a misleading warning

[Older changelogs can be found there](CHANGELOG_OLD.md)

## License

MIT License

Copyright (c) 2025-2026 iobroker-community-adapters <iobroker-community-adapters@gmx.de>  
Copyright (c) 2020-2024 bropat <patrick.broetto@gmail.com>

The web pages in `www/` that go2rtc serves are taken from [go2rtc](https://github.com/AlexxIT/go2rtc),
MIT licensed by Alexey Khit (2022). Their license text is in `www/LICENSE.go2rtc`, the list
of files and what was changed is in `www/VENDOR.md`.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
