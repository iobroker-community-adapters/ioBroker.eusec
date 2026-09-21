# Configuration

Please create a separate Eufy account to which you share your devices with admin rights.
The minimal configuration requires that you enter a username and a password.
See below for more configuration parameters.

## General settings

  ![General configuration page](_media/en/config01.png)

  | Configuration parameter | Description |
  | - | - |
  | Username | Your Eufy account username |
  | Password | Your Eufy account password |
  | Polling intervall (min.) | The data is retrieved from the Eufy Cloud again every x minutes |
  | Time in seconds before event reset | Time in seconds before a motion event, person detected event, etc. is reset |
  | Alarm sound duration (sec) | Time in seconds after the triggered alarm is silenced. |
  | P2P connection type | Choose which P2P connection you prefer. |
  | Accept incoming invitations | Share invitation are automatically accepted if enabled. |

### Parmeter: P2P connection type

  | Choosable value | Description |
  | - | - |
  | Only local connection | It will only try to establish the P2P connection with the local address of the respective Eufy device. |
  | Quickest connection | It tries to establish the fastest possible P2P connection with the respective Eufy device, regardless of whether it is local or via the Eufy Cloud. |

## Livestream settings

  ![Livestream configuration page](_media/en/config02.png)

### General settings

  | Configuration parameter | Description |
  | - | - |
  | Hostname streaming url | If this option is set, the host name will be overwritten in the livesteam URLs. |
  | HTTPS streaming url | If this option is set, the livesteam URL will be generated in HTTPS. |
  | Max camera livestream duration | Maximum duration of a live stream in seconds after it is stopped. 0 seconds equal unlimited |

### go2rtc settings

  | Configuration parameter | Description |
  | - | - |
  | API port | go2rtc API port setting |
  | SRTP port | go2rtc SRTP port setting |
  | WebRTC port | go2rtc WebRTC port setting |
  | RTSP port | go2rtc RTSP port setting |
  | RTSP username | go2rtc RTSP username setting |
  | RTSP password | go2rtc RTSP password setting |
  | Devices with a compatibility stream | Serial numbers of cameras whose livestream is re-encoded to 1280x720 H.264 before it reaches the player, for old WebViews, kiosk tablets and hardware decoders that cannot handle the resolution the camera sends. The states `livestream` and `livestream_rtsp` of such a camera point at the transcoded stream `<serial>_compat`, the untouched stream stays available under `<serial>`. Transcoding costs CPU on the ioBroker host while the stream is watched. |
