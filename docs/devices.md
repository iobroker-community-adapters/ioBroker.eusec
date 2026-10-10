# Supported devices

The adapter talks to the devices through the [eufy-security-client](https://github.com/bropat/eufy-security-client)
library (version 4.1.1). Every device that library knows works with the adapter as well; see its
[list of supported devices](https://bropat.github.io/eufy-security-client/#/supported_devices).

That library is no longer developed. The devices below are missing from its list or do not work
with the library alone; the adapter corrects them itself.

| Device | What works | Known limits | Issue |
| --- | --- | --- | --- |
| eufyCam C31 (T817L) | Livestream, motion and person detection, light, alarm. The library does not know the camera; the adapter handles it like the SoloCam Spotlight 1080. | No pan and tilt yet. The camera shows battery states although it is mains powered. | [#156](https://github.com/iobroker-community-adapters/ioBroker.eusec/issues/156) |
| eufyCam C37 (T814X) | The library does not know the camera; the adapter handles it like the eufyCam S4, which gives it livestream, motion, person and vehicle detection, light, pan and tilt and battery states. | Not confirmed on a real camera yet. The `enabled` state has no value, since the camera does not report it. | [#198](https://github.com/iobroker-community-adapters/ioBroker.eusec/issues/198) |
| Floodlight Cam E30 (T8426) | Livestream, preset positions, pan and tilt. The library sends the camera the commands of older floodlights; the adapter sends it those of the Floodlight Cam E340 (T8425) instead. | Talkback, calibration and the light and detection settings are not confirmed on a real camera yet. Available from 3.4.0. | |

Your device is missing from both lists or does not work as described? Open an
[issue](https://github.com/iobroker-community-adapters/ioBroker.eusec/issues) with the model number
and a debug log of the adapter start (see [Debugging](debugging.md)).
