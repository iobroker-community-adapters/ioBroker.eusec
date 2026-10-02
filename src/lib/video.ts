import type { Readable } from 'node:stream';
import { type StreamMetadata, VideoCodec } from 'eufy-security-client';

import stream from 'node:stream';
import { pipeline as streamPipeline } from 'node:stream/promises';

import type { ioBrokerLogger } from './log';
import { isRegularStreamEnd } from './go2rtc';
import { createSpsLevelPatcher } from './h264';
import { getShortUrl } from './utils';

/**
 * Builds the transform the video of a livestream passes on its way to go2rtc.
 *
 * The cameras declare a fixed level 4.2 in their SPS, which makes decoders that stop at a lower
 * level render the stream as green macroblocks. Only H.264 has that layout - anything else is
 * handed to go2rtc untouched.
 *
 * @param camera Serial of the device, for the log
 * @param metadata Metadata of the livestream
 * @param log Logger
 * @returns The transform to put in front of go2rtc
 */
export const createVideoFilter = (camera: string, metadata: StreamMetadata, log: ioBrokerLogger): stream.Transform =>
    metadata.videoCodec === VideoCodec.H264
        ? createSpsLevelPatcher(metadata.videoFPS, (from, to) =>
              log.info(
                  `streamToGo2rtc(): ${camera} - Declared H.264 level ${(from / 10).toFixed(1)} replaced with ${(to / 10).toFixed(1)}`,
              ),
          )
        : new stream.PassThrough();

export const streamToGo2rtc = async (
    camera: string,
    videoStream: Readable,
    audioStream: Readable,
    log: ioBrokerLogger,
    config: ioBroker.AdapterConfig,
    _namespace: string,
    metadata: StreamMetadata,
): Promise<Array<PromiseSettledResult<void>>> => {
    const { default: got } = await import('got');
    const api = got.extend({
        hooks: {
            beforeError: [
                error => {
                    const { response, options } = error;
                    const { method, url, prefixUrl } = options;
                    const shortUrl = getShortUrl(
                        typeof url === 'string' ? new URL(url) : url === undefined ? new URL('') : url,
                        typeof prefixUrl === 'string' ? prefixUrl : prefixUrl.toString(),
                    );
                    const body = response?.body ? response.body : error.message;
                    error.message = `${error.message} | method: ${method} url: ${shortUrl}`;
                    if (response?.body) {
                        // eslint-disable-next-line @typescript-eslint/no-base-to-string
                        error.message = `${error.message} body: ${typeof body === 'object' ? JSON.stringify(body) : body?.toString()}`;
                    }
                    return error;
                },
            ],
        },
    });
    videoStream.on('error', error => {
        log.error('streamToGo2rtc(): Videostream Error', error);
    });

    audioStream.on('error', error => {
        log.error('streamToGo2rtc(): Audiostream Error', error);
    });
    const videoFilter = createVideoFilter(camera, metadata, log);

    const ingestUrl = `http://localhost:${config.go2rtc_api_port}/api/stream?dst=${camera}`;
    // Node only sends the request header together with the first chunk of the body. The camera may
    // take longer than 5 seconds to deliver its first audio (or video) data, and go2rtc drops every
    // connection whose header did not arrive within its ReadHeaderTimeout of 5 seconds - the POST
    // then fails with "socket hang up" and the stream stays without that track.
    const ingest = (): ReturnType<typeof api.stream.post> =>
        api.stream.post(ingestUrl).on('request', request => request.flushHeaders());
    const results = await Promise.allSettled([
        streamPipeline(
            videoStream,
            videoFilter,
            ingest().on('error', (error: any) => {
                if (!isRegularStreamEnd(error)) {
                    log.error(`streamToGo2rtc(): Got Videostream Error: ${error.message}`);
                }
            }),
            new stream.PassThrough(),
        ),
        streamPipeline(
            audioStream,
            ingest().on('error', (error: any) => {
                if (!isRegularStreamEnd(error)) {
                    log.error(`streamToGo2rtc(): Got Audiostream Error: ${error.message}`);
                }
            }),
            new stream.PassThrough(),
        ),
    ]);

    // Without this the rejection is swallowed by allSettled and a dead pipeline stays invisible,
    // while the camera keeps streaming until the maximum livestream duration expires.
    for (const result of results) {
        if (result.status === 'rejected' && !isRegularStreamEnd(result.reason)) {
            log.error(`streamToGo2rtc(): Stream to go2rtc failed: ${result.reason}`);
        }
    }

    return results;
};
