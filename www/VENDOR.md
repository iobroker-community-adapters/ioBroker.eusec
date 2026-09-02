# Web files served by go2rtc

The adapter points `api.static_dir` of go2rtc at this directory. That **replaces** the files
embedded in the go2rtc binary - once it is set, go2rtc serves nothing of its own any more, only
`/api/*` stays untouched. The player of the adapter has to live here, because go2rtc answers a
WebSocket from a different origin with "403 Forbidden" and `/api/stream.mp4`, the only endpoint
that works cross origin, is refused by Chrome and Edge with `NotSupportedError`.

Everything of go2rtc that is useful in an adapter is shipped along (MIT, AlexxIT/go2rtc), so that
nothing disappears for anyone who opened these pages before:

| File | Origin | Why it is here |
| --- | --- | --- |
| `stream.html` | **the adapter** | the page of go2rtc with different defaults, see the comment inside |
| `video-rtc.js`, `video-stream.js` | unmodified | `stream.html` builds on both |
| `index.html` | **modified** | the stream list - which cameras exist and whether one is streaming |
| `main.js` | **modified** | navigation and dark mode of the pages above |
| `log.html` | unmodified | the go2rtc log over `/api/log`, without shell access to the host |
| `links.html` | unmodified | the RTSP, HLS, MJPEG and snapshot URL of a camera |
| `webrtc.html` | unmodified | a WebRTC only viewer - it works, it is just the wrong transport here |

## What was left out, and why

- `editor.html` - the adapter passes the whole go2rtc configuration as JSON on the command line,
  so `GET`/`POST /api/config` answer `410 Gone`. The page cannot even display the configuration.
- `add.html` - `PUT /api/streams` does add a stream to the running process, but the adapter
  rebuilds the configuration on every start, so it is gone with the next restart. The page also
  offers HomeKit and Roborock pairing, which has nothing to do with this adapter.
- `network.html` - loads `vis-network` from `unpkg.com`. On a host without internet access the
  page stays blank, and an adapter should not send its users to a third party CDN.

The two modified files carry an `eusec:` comment at the place that was changed: the three nav
entries in `main.js` and the per stream `net` link in `index.html`. `stream.html` also drops the
icon and manifest links to `alexxit.github.io` that the original had - three external requests on
every mount are not what a tablet needs.

## Refreshing the copies

After a major bump of `go2rtc-static`, take the files from the new binary:

```sh
./node_modules/go2rtc-static/dist/go2rtc -config '{"api":{"listen":":19843"},"rtsp":{"listen":":18556"}}' &
cd www
for f in links.html webrtc.html log.html video-rtc.js video-stream.js; do
    curl -s "http://127.0.0.1:19843/$f" -o "$f"
done
```

`stream.html`, `index.html` and `main.js` are **not** overwritten - fetch the originals to a
temporary file, diff them and carry over what changed upstream. Then check that no page links to a
file that is not here, because a new version of go2rtc may add one:

```sh
grep -ohE 'href="[a-z0-9._-]+\.(html|js)"' *.html *.js | sort -u
```
