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
  | Hostname streaming url | Host name or address used in the livestream URLs. If empty, the URLs use the IPv4 address of the ioBroker host the instance runs on in the LAN, or its name if it has no such address. |
  | HTTPS streaming url | If this option is set, the livesteam URL will be generated in HTTPS. |
  | Max camera livestream duration | Maximum duration of a livestream in seconds, counted from its first picture. 0 seconds equal unlimited |
  | Wait for camera data (sec) | How long a livestream waits for data from the camera before it is given up (5 to 60 seconds, default 15). Battery cameras that first have to wake up often need more than 5 seconds. |
  | Livestream quality | Sets the streaming quality of every camera to low, medium or high before its livestream starts. At "Auto" the camera changes the resolution while the livestream runs, which browsers cannot follow (green or frozen picture). The setting changes the camera itself, like the eufy app does. Devices that name their qualities by resolution are left alone. Default: as set on the camera. |
  | Start livestreams on demand | The livestream of a camera starts as soon as its player page or RTSP URL is opened and stops shortly after the last viewer left, so `start_stream` is not needed. The states `livestream` and `livestream_rtsp` always carry the URL. A station carries one livestream at a time: while one of its cameras is watched, the player of another one waits until the station is free. A camera that is watched around the clock streams around the clock, which drains the battery of a battery camera. The player page and API port of go2rtc have no authentication, so every device in the network that reaches them can wake the cameras. Off by default. |

### go2rtc settings

  | Configuration parameter | Description |
  | - | - |
  | API port | go2rtc API port setting |
  | SRTP port | go2rtc SRTP port setting |
  | WebRTC port | go2rtc WebRTC port setting |
  | RTSP port | go2rtc RTSP port setting |
  | RTSP username | go2rtc RTSP username setting |
  | RTSP password | go2rtc RTSP password setting |
  | Devices with a compatibility stream | Serial numbers of cameras whose livestream is re-encoded to 720p H.264 before it reaches the player, for old WebViews, kiosk tablets and hardware decoders that cannot handle the resolution the camera sends. The states `livestream` and `livestream_rtsp` of such a camera point at the transcoded stream `<serial>_compat`, the untouched stream stays available under `<serial>`. Transcoding costs CPU on the ioBroker host while the stream is watched. |

## Streams

  The tab "Streams" lists every device with a livestream: name, model, serial number and station, the player URL to open and the RTSP URL. A device with a compatibility stream also gets a link to the untouched stream. Below the table the tab says whether opening a URL starts the livestream and which address the URLs use when no host name is configured.
