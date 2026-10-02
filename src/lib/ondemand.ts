import http from 'node:http';
import type { AddressInfo } from 'node:net';
import stream, { type Readable, type Transform } from 'node:stream';

/**
 * Livestreams that start when somebody watches them.
 *
 * In this mode go2rtc does not wait for the adapter to push a stream. Every device stream gets two
 * http sources pointing at the server below, one for video and one for audio. go2rtc only opens
 * them when a consumer (player page, RTSP client, compatibility stream) asks for the stream, opens
 * them again when they end while the stream is still watched, and closes them once the last
 * consumer left. The server turns the first request into a livestream start, and the last closed
 * request - after a grace period - into a livestream stop.
 *
 * Deliberately free of adapter imports, so it stays testable without a running js-controller.
 */

export type OnDemandTrack = 'video' | 'audio';

export interface OnDemandHooks {
    /** Asks the camera to start a livestream. The stream itself arrives through attach(). */
    start: (serial: string) => Promise<void>;
    /** Stops the livestream, called once nobody watched it for the grace period. */
    stop: (serial: string) => Promise<void>;
    /**
     * Devices that cannot stream at the same time share a group - the station they are connected
     * through, which carries only one livestream at a time.
     */
    group?: (serial: string) => string | undefined;
    /** Name of a device for messages a viewer sees. */
    name?: (serial: string) => string | undefined;
    log: {
        debug: (message: string) => void;
        info: (message: string) => void;
        warn: (message: string) => void;
    };
}

export interface OnDemandOptions {
    /** How long a livestream keeps running after the last consumer left (page reload, tab switch). */
    idleStopDelay: number;
    /** The same, while another device of the station waits for it to be free. */
    handoverDelay: number;
    /** How long a request waits for the camera before go2rtc is told the stream is unavailable. */
    firstDataTimeout: number;
    /** How long after the first video data audio may take before the camera counts as mute. */
    audioTimeout: number;
    /**
     * How long a start that has not delivered yet keeps the other devices of the station out. A
     * camera that never answers must not block the station for as long as its player retries.
     */
    startBlock: number;
    /** How long a device whose start attempts all failed is not started again. */
    unreachableFor: number;
}

export const DEFAULT_START_ATTEMPT_OPTIONS: StartAttemptOptions = {
    attempts: 3,
    watch: 90,
    noResponse: 75,
    endWait: 5,
};

export const DEFAULT_OPTIONS: OnDemandOptions = {
    idleStopDelay: 10000,
    handoverDelay: 1000,
    // Outlasts every attempt of startUntilDelivered(), plus the time the start commands take. A 504
    // in between makes go2rtc ask again, and for that moment nobody waits - the attempts would stop
    // as if the livestream had arrived, and a camera that never answers is never paused.
    firstDataTimeout:
        DEFAULT_START_ATTEMPT_OPTIONS.attempts *
            (DEFAULT_START_ATTEMPT_OPTIONS.endWait + DEFAULT_START_ATTEMPT_OPTIONS.watch) *
            1000 +
        15000,
    audioTimeout: 5000,
    // The slowest start that still delivered took 62 seconds.
    startBlock: 70000,
    unreachableFor: 60000,
};

const SERIAL = /^[A-Za-z0-9_-]+$/;

/** Restricts a device name to printable ASCII, as an HTTP reason phrase requires. */
const asciiName = (name: string): string => {
    const ascii = name
        .replace(/ä/g, 'ae')
        .replace(/ö/g, 'oe')
        .replace(/ü/g, 'ue')
        .replace(/Ä/g, 'Ae')
        .replace(/Ö/g, 'Oe')
        .replace(/Ü/g, 'Ue')
        .replace(/ß/g, 'ss')
        .replace(/[^\x20-\x7e]/g, '')
        .trim();
    return ascii || 'another device';
};

/**
 * Reason phrase of the answer to go2rtc while the station carries another livestream. go2rtc
 * hands it on to the player ("streams: 503 Station busy - Garden is streaming"), and the player page
 * of the adapter recognises it - keep the two in step with www/stream.html.
 *
 * @param name Name of the device whose livestream occupies the station
 * @returns The reason phrase, restricted to printable ASCII as HTTP requires
 */
export const busyReason = (name: string): string => `Station busy - ${asciiName(name)} is streaming`;

/**
 * Reason phrase of the answer to go2rtc while a device is paused after its start attempts failed.
 * Recognised by the player page like busyReason().
 *
 * @param name Name of the device
 * @returns The reason phrase, restricted to printable ASCII as HTTP requires
 */
export const unreachableReason = (name: string): string => `Camera not reachable - ${asciiName(name)}`;

interface Sink {
    response: http.ServerResponse;
    timeout: NodeJS.Timeout;
    /** Whether the data already starts at a point go2rtc can begin with. */
    aligned: boolean;
    /** go2rtc does not keep up reading - data is dropped until the response drained. */
    congested: boolean;
}

/**
 * Finds where a request that joins a running livestream can begin: the start code of the next
 * parameter set that introduces a keyframe - SPS of H.264, VPS of H.265. The camera does not send
 * its video in whole frames, and go2rtc only recognises the format by a start code at the very
 * first byte ("magic: unsupported header" otherwise).
 *
 * @param data A chunk of the Annex B video stream
 * @param h265 Whether the stream is H.265 instead of H.264
 * @returns Offset of the four byte start code, or -1 if the chunk holds none
 */
export const findKeyframeStart = (data: Buffer, h265 = false): number => {
    for (let i = 0; i + 3 < data.length; i++) {
        if (data[i] !== 0 || data[i + 1] !== 0 || data[i + 2] !== 1) {
            continue;
        }
        // The NAL header differs between the codecs - an H.264 P slice (0x41) reads as an H.265 VPS.
        const header = data[i + 3];
        if (h265 ? ((header >> 1) & 0x3f) === 32 : (header & 0x1f) === 7) {
            return i > 0 && data[i - 1] === 0 ? i - 1 : i;
        }
    }
    return -1;
};

/**
 * Finds the first ADTS frame header, where a request that joins a running audio stream can begin.
 *
 * @param data A chunk of the ADTS audio stream
 * @returns Offset of the sync word, or -1 if the chunk holds none
 */
export const findAdtsStart = (data: Buffer): number => {
    for (let i = 0; i + 1 < data.length; i++) {
        if (data[i] === 0xff && (data[i + 1] & 0xf6) === 0xf0) {
            return i;
        }
    }
    return -1;
};

interface Live {
    video: Readable;
    audio: Readable;
    videoFilter: Transform;
    videoSeen: boolean;
    audioSeen: boolean;
    /** No audio arrived within audioTimeout - audio requests are answered right away. */
    mute: boolean;
    h265: boolean;
    audioTimer?: NodeJS.Timeout;
}

interface Session {
    sinks: Record<OnDemandTrack, Set<Sink>>;
    live?: Live;
    /**
     * The start hook while it runs - its retries included. There is only ever one per device:
     * requests that come while it runs, also the next ones of go2rtc after a 504, wait for it.
     */
    start?: Promise<void>;
    /**
     * A livestream was asked for and has not delivered yet. Outlives the start hook: a start that
     * nobody waits for anymore is stopped once the grace period passed.
     */
    starting: boolean;
    /** Whether a consumer was attached since the livestream started - only then it is stopped. */
    watched: boolean;
    /** When go2rtc asked for a livestream that was not running, for the log. */
    requestedAt?: number;
    /** The device whose livestream the last refusal was logged for. */
    refusedFor?: string;
    /** When go2rtc was last refused for this device because the station was busy. */
    refusedAt?: number;
    /** When the current start began - a start blocks the station only for a while. */
    startedAt?: number;
    /** All start attempts failed - the device is not started again before this time. */
    unreachableUntil?: number;
    stopTimer?: NodeJS.Timeout;
}

/**
 * Builds the go2rtc source of one track of an on-demand stream.
 *
 * @param port Port of the on-demand server
 * @param serial Serial of the device
 * @param track Video or audio
 * @returns The http source for the go2rtc configuration
 */
export const onDemandSource = (port: number, serial: string, track: OnDemandTrack): string =>
    `http://127.0.0.1:${port}/${encodeURIComponent(serial)}/${track}`;

/**
 * Parses the path of a request to the on-demand server.
 *
 * @param url Path and query of the request
 * @returns Serial and track, or undefined for anything else
 */
export const parseOnDemandPath = (url: string | undefined): { serial: string; track: OnDemandTrack } | undefined => {
    const [, serial, track, rest] = (url ?? '').split('?')[0].split('/');
    if (rest !== undefined || !SERIAL.test(serial ?? '') || (track !== 'video' && track !== 'audio')) {
        return undefined;
    }
    return { serial, track };
};

export class OnDemandStreams {
    private readonly server: http.Server;
    private readonly sessions = new Map<string, Session>();
    private readonly options: OnDemandOptions;
    private port = 0;

    public constructor(
        private readonly hooks: OnDemandHooks,
        options: Partial<OnDemandOptions> = {},
    ) {
        this.options = { ...DEFAULT_OPTIONS, ...options };
        this.server = http.createServer((request, response) => this.onRequest(request, response));
        // A livestream request stays open as long as the camera streams.
        this.server.requestTimeout = 0;
        this.server.headersTimeout = 10000;
    }

    /**
     * Starts the server on a free port of the loopback interface - only go2rtc talks to it.
     *
     * @returns The port the server listens on
     */
    public async listen(): Promise<number> {
        await new Promise<void>((resolve, reject) => {
            this.server.once('error', reject);
            this.server.listen(0, '127.0.0.1', () => {
                this.server.off('error', reject);
                resolve();
            });
        });
        this.port = (this.server.address() as AddressInfo).port;
        return this.port;
    }

    /**
     * The go2rtc sources of a device stream.
     *
     * @param serial Serial of the device
     * @returns Video and audio source
     */
    public sources(serial: string): string[] {
        return [onDemandSource(this.port, serial, 'video'), onDemandSource(this.port, serial, 'audio')];
    }

    /**
     * Hands a started livestream to the waiting and future requests of go2rtc. Called for every
     * livestream of the device, also one started for talkback or through start_stream.
     *
     * @param serial Serial of the device
     * @param video Video stream from the camera
     * @param audio Audio stream from the camera
     * @param videoFilter Transform the video passes before it reaches go2rtc
     * @param h265 Whether the video is H.265 instead of H.264
     */
    public attach(serial: string, video: Readable, audio: Readable, videoFilter?: Transform, h265 = false): void {
        const session = this.session(serial);
        this.endLive(session);
        session.starting = false;
        session.unreachableUntil = undefined;
        session.watched = this.sinkCount(session) > 0;
        const live: Live = {
            video,
            audio,
            videoFilter: videoFilter ?? new stream.PassThrough(),
            videoSeen: false,
            audioSeen: false,
            mute: false,
            h265,
        };
        session.live = live;

        // The camera streams no matter whether anybody listens, so the data always flows and is
        // dropped while no request of go2rtc is attached.
        video.on('data', (chunk: Buffer) => live.videoFilter.write(chunk));
        live.videoFilter.on('data', (chunk: Buffer) => {
            if (!live.videoSeen) {
                live.videoSeen = true;
                const waited =
                    session.requestedAt !== undefined
                        ? ` ${Math.round((Date.now() - session.requestedAt) / 1000)} seconds after the request`
                        : '';
                session.requestedAt = undefined;
                this.hooks.log.info(
                    `On-demand stream ${serial}: first picture${waited}, ${session.sinks.video.size} video request(s) of go2rtc waiting`,
                );
                live.audioTimer = setTimeout(() => {
                    if (!live.audioSeen && session.live === live) {
                        live.mute = true;
                        this.hooks.log.info(
                            `On-demand stream ${serial}: no audio within ${this.options.audioTimeout / 1000} seconds - continuing without`,
                        );
                        this.endSinks(session, 'audio', 404);
                    }
                }, this.options.audioTimeout);
            }
            this.write(session, 'video', chunk, serial);
        });
        audio.on('data', (chunk: Buffer) => {
            live.audioSeen = true;
            // Audio that comes late is audio nevertheless - the next request of go2rtc gets it.
            live.mute = false;
            this.write(session, 'audio', chunk, serial);
        });
        // Errors of the camera streams are logged by the adapter, they only must not crash it.
        video.on('error', () => {});
        audio.on('error', () => {});
        live.videoFilter.on('error', () => {});
    }

    /**
     * Pauses the starts of a device whose start attempts all failed, and frees its station: the
     * waiting requests of go2rtc are answered right away, and new ones get the same answer until
     * unreachableFor passed.
     *
     * @param serial Serial of the device
     */
    public markUnreachable(serial: string): void {
        const session = this.session(serial);
        if (session.live) {
            return;
        }
        session.starting = false;
        session.unreachableUntil = Date.now() + this.options.unreachableFor;
        const reason = unreachableReason(this.hooks.name?.(serial) ?? serial);
        for (const track of ['video', 'audio'] as const) {
            for (const sink of [...session.sinks[track]]) {
                if (!sink.response.headersSent) {
                    this.removeSink(session, track, sink);
                    sink.response.writeHead(503, reason).end();
                }
            }
        }
    }

    /**
     * Tells whether go2rtc waits for a livestream of the device that has not arrived yet.
     *
     * @param serial Serial of the device
     * @returns true while at least one request waits and no livestream is attached
     */
    public isWaiting(serial: string): boolean {
        const session = this.sessions.get(serial);
        return session !== undefined && !session.live && this.sinkCount(session) > 0;
    }

    /**
     * Tells whether go2rtc consumes the stream of the device - waiting for it or receiving it.
     *
     * @param serial Serial of the device
     * @returns true while at least one request of go2rtc is open
     */
    public isWatched(serial: string): boolean {
        const session = this.sessions.get(serial);
        return session !== undefined && this.sinkCount(session) > 0;
    }

    /**
     * Ends the requests of go2rtc for a livestream that stopped. go2rtc opens them again right away
     * if the stream is still watched, which starts the next livestream.
     *
     * @param serial Serial of the device
     */
    public detach(serial: string): void {
        const session = this.sessions.get(serial);
        if (!session) {
            return;
        }
        this.endLive(session);
        // A start hook that still runs starts the livestream again for the waiting requests.
        session.starting = session.start !== undefined;
        for (const track of ['video', 'audio'] as const) {
            for (const sink of [...session.sinks[track]]) {
                // A request that got no data yet waits for the next livestream instead.
                if (sink.response.headersSent) {
                    this.removeSink(session, track, sink);
                    sink.response.end();
                }
            }
        }
        this.clearStopTimer(session);
    }

    public async close(): Promise<void> {
        for (const session of this.sessions.values()) {
            this.clearStopTimer(session);
            this.endLive(session);
            for (const track of ['video', 'audio'] as const) {
                for (const sink of [...session.sinks[track]]) {
                    this.removeSink(session, track, sink);
                    sink.response.destroy();
                }
            }
        }
        this.sessions.clear();
        this.server.closeAllConnections();
        await new Promise<void>(resolve => this.server.close(() => resolve()));
    }

    private onRequest(request: http.IncomingMessage, response: http.ServerResponse): void {
        const target = request.method === 'GET' ? parseOnDemandPath(request.url) : undefined;
        if (!target) {
            response.writeHead(404).end();
            return;
        }
        const { serial, track } = target;
        const session = this.session(serial);
        if (track === 'audio' && session.live?.mute) {
            response.writeHead(404).end();
            return;
        }
        if (!session.live && (session.unreachableUntil ?? 0) > Date.now()) {
            // Waking a camera that did not answer the last attempts only keeps the station busy.
            this.hooks.log.debug(`On-demand stream ${serial}: not reachable - not started`);
            response.writeHead(503, unreachableReason(this.hooks.name?.(serial) ?? serial)).end();
            return;
        }
        if (!session.live && !session.starting) {
            // Starting this device would end the livestream somebody is watching on another
            // device of the same station. go2rtc asks again later.
            const busy = this.stationBusyWith(serial);
            if (busy) {
                // go2rtc asks again every few seconds, for video and audio - say it once.
                const message = `On-demand stream ${serial}: the station is busy with the livestream of ${busy} - not started`;
                if (session.refusedFor === busy) {
                    this.hooks.log.debug(message);
                } else {
                    this.hooks.log.info(message);
                    session.refusedFor = busy;
                }
                session.refusedAt = Date.now();
                response.writeHead(503, busyReason(this.hooks.name?.(busy) ?? busy)).end();
                return;
            }
            session.refusedFor = undefined;
            session.refusedAt = undefined;
        }

        const sink: Sink = {
            response,
            aligned: false,
            congested: false,
            timeout: setTimeout(() => {
                this.hooks.log.warn(
                    `On-demand stream ${serial}: the camera delivered no ${track} within ${this.options.firstDataTimeout / 1000} seconds`,
                );
                // Only this request ends. A start that still runs - its retries take longer than
                // this - keeps running, and the next request of go2rtc waits for it.
                this.removeSink(session, track, sink);
                response.writeHead(504).end();
            }, this.options.firstDataTimeout),
        };
        session.sinks[track].add(sink);
        session.watched = true;
        this.clearStopTimer(session);
        const opened = Date.now();
        response.on('close', () => {
            if (this.removeSink(session, track, sink)) {
                if (!response.headersSent) {
                    this.hooks.log.info(
                        `On-demand stream ${serial}: go2rtc stopped waiting for the ${track} after ${Math.round((Date.now() - opened) / 1000)} seconds`,
                    );
                }
                this.scheduleStop(serial, session);
            }
        });

        this.hooks.log.debug(
            `On-demand stream ${serial}: go2rtc requests the ${track}${session.live ? ' of the running livestream' : ''}`,
        );
        if (!session.live && !session.start) {
            session.starting = true;
            session.requestedAt = Date.now();
            session.startedAt = session.requestedAt;
            this.hooks.log.info(`On-demand stream ${serial}: requested by go2rtc - starting livestream`);
            const start: Promise<void> = this.hooks
                .start(serial)
                .catch(error => {
                    session.starting = false;
                    this.hooks.log.warn(`On-demand stream ${serial}: livestream could not be started: ${error}`);
                })
                .finally(() => {
                    if (session.start === start) {
                        session.start = undefined;
                    }
                });
            session.start = start;
        }
    }

    /**
     * Finds another device of the same group whose livestream is starting or watched. Starting
     * the requested device would end that livestream.
     *
     * @param serial Serial of the device that is requested
     * @returns The serial of that device, if there is one
     */
    public stationBusyWith(serial: string): string | undefined {
        const group = this.hooks.group?.(serial);
        if (group === undefined) {
            return undefined;
        }
        for (const [other, session] of this.sessions) {
            // A start that has not delivered yet blocks only for a while - a camera that never
            // answers would otherwise keep the station for as long as its player retries.
            const starting = session.starting && Date.now() - (session.startedAt ?? 0) < this.options.startBlock;
            if (
                other !== serial &&
                (session.live || starting) &&
                this.sinkCount(session) > 0 &&
                this.hooks.group?.(other) === group
            ) {
                return other;
            }
        }
        return undefined;
    }

    private write(session: Session, track: OnDemandTrack, chunk: Buffer, serial: string): void {
        for (const sink of session.sinks[track]) {
            if (sink.congested) {
                continue;
            }
            let data = chunk;
            if (!sink.aligned) {
                // A request that joins a running livestream starts at the next keyframe or audio
                // frame - go2rtc detects the format from the first bytes and refuses anything else.
                const offset = track === 'video' ? findKeyframeStart(chunk, session.live?.h265) : findAdtsStart(chunk);
                if (offset < 0) {
                    continue;
                }
                data = chunk.subarray(offset);
                if (track === 'video' && data[2] === 1) {
                    // go2rtc only recognises the four byte start code.
                    data = Buffer.concat([Buffer.from([0]), data]);
                }
                sink.aligned = true;
            }
            if (!sink.response.headersSent) {
                clearTimeout(sink.timeout);
                // go2rtc detects the format from the data itself.
                sink.response.writeHead(200, { 'Content-Type': 'application/octet-stream' });
            }
            if (!sink.response.write(data)) {
                // The camera does not wait for a slow reader, so buffering for it would grow
                // without limit. Drop the data instead, and go on at the next keyframe or audio
                // frame once the response drained - go2rtc cannot decode from the middle of one.
                sink.congested = true;
                this.hooks.log.debug(
                    `On-demand stream ${serial}: go2rtc does not keep up with the ${track} - dropping data`,
                );
                sink.response.once('drain', () => {
                    sink.congested = false;
                    sink.aligned = false;
                });
            }
        }
    }

    private scheduleStop(serial: string, session: Session): void {
        if (this.sinkCount(session) > 0 || !session.watched) {
            return;
        }
        this.clearStopTimer(session);
        session.stopTimer = setTimeout(
            () => {
                session.stopTimer = undefined;
                // A start that never delivered is stopped as well - otherwise the camera stays busy
                // with it until the maximum livestream duration.
                if (this.sinkCount(session) > 0 || (!session.live && !session.starting)) {
                    return;
                }
                session.watched = false;
                session.starting = false;
                this.hooks.log.info(`On-demand stream ${serial}: nobody watches anymore - stopping livestream`);
                this.hooks.stop(serial).catch(error => {
                    this.hooks.log.warn(`On-demand stream ${serial}: livestream could not be stopped: ${error}`);
                });
                // A page reload comes back within the grace period, a viewer of another device of the
                // station is not served until this livestream ends - hand the station over quickly.
            },
            this.waitedFor(serial) ? this.options.handoverDelay : this.options.idleStopDelay,
        );
    }

    /**
     * Tells whether another device of the same group was refused recently because of this one.
     *
     * @param serial Serial of the device whose livestream nobody watches anymore
     * @returns true if a player of another device waits for the station
     */
    private waitedFor(serial: string): boolean {
        const group = this.hooks.group?.(serial);
        if (group === undefined) {
            return false;
        }
        const recent = Date.now() - 30000;
        for (const [other, session] of this.sessions) {
            if (
                other !== serial &&
                session.refusedFor === serial &&
                (session.refusedAt ?? 0) > recent &&
                this.hooks.group?.(other) === group
            ) {
                return true;
            }
        }
        return false;
    }

    private session(serial: string): Session {
        let session = this.sessions.get(serial);
        if (!session) {
            session = { sinks: { video: new Set(), audio: new Set() }, starting: false, watched: false };
            this.sessions.set(serial, session);
        }
        return session;
    }

    private sinkCount(session: Session): number {
        return session.sinks.video.size + session.sinks.audio.size;
    }

    private removeSink(session: Session, track: OnDemandTrack, sink: Sink): boolean {
        clearTimeout(sink.timeout);
        return session.sinks[track].delete(sink);
    }

    private endSinks(session: Session, track: OnDemandTrack, status: number): void {
        for (const sink of [...session.sinks[track]]) {
            this.removeSink(session, track, sink);
            if (sink.response.headersSent) {
                sink.response.end();
            } else {
                sink.response.writeHead(status).end();
            }
        }
    }

    private endLive(session: Session): void {
        const live = session.live;
        if (!live) {
            return;
        }
        clearTimeout(live.audioTimer);
        live.video.removeAllListeners('data');
        live.audio.removeAllListeners('data');
        live.videoFilter.removeAllListeners('data');
        // Keep whatever is left of an old stream from piling up in memory.
        live.video.resume();
        live.audio.resume();
        session.live = undefined;
    }

    private clearStopTimer(session: Session): void {
        if (session.stopTimer) {
            clearTimeout(session.stopTimer);
            session.stopTimer = undefined;
        }
    }
}

export interface StartAttemptHooks {
    /** Whether the library counts the device as streaming. */
    isStreaming: (serial: string) => Promise<boolean>;
    /** Asks the camera to start a livestream. */
    start: (serial: string) => Promise<void>;
    /** Gives up a livestream the camera never answered. */
    stop: (serial: string) => Promise<void>;
    /** Whether go2rtc still waits for the livestream - false once it arrived or nobody waits. */
    isWaiting: (serial: string) => boolean;
    /** Pauses the starts of a device whose attempts all failed, see markUnreachable(). */
    markUnreachable: (serial: string) => void;
    /** Whether the adapter shuts down. */
    cancelled: () => boolean;
    sleep: (ms: number) => Promise<void>;
    log: {
        debug: (message: string) => void;
        info: (message: string) => void;
        warn: (message: string) => void;
    };
}

export interface StartAttemptOptions {
    /** Livestream starts per request, for cameras that acknowledge a start and send nothing. */
    attempts: number;
    /** How long one start is watched for one of the two ways it can fail, in seconds. */
    watch: number;
    /**
     * A camera that sends nothing for this long after a start is not going to, in seconds:
     * measured were starts that delivered after 23, 24, 54 and 62 seconds, and ones that delivered
     * nothing for 120 seconds.
     */
    noResponse: number;
    /** How long a start waits for a livestream that just ended to no longer count as running, in seconds. */
    endWait: number;
}

/**
 * Starts a livestream go2rtc asked for, and starts it again when it fails without any event. It
 * fails in two ways: the camera acknowledges the start and sends nothing, and the library gives
 * the livestream up - the device stops counting as streaming. Or the camera never answers at all,
 * and the library keeps the livestream running until the maximum duration.
 *
 * go2rtc asks again as soon as a livestream ended at the maximum duration, which can be before the
 * library stopped counting it as running - a plain start would then be refused with "already
 * streaming" and nothing would come.
 *
 * @param serial Serial of the device
 * @param hooks What the attempts act on
 * @param options Attempts and timeouts, the defaults are measured on battery cameras
 */
export const startUntilDelivered = async (
    serial: string,
    hooks: StartAttemptHooks,
    options: Partial<StartAttemptOptions> = {},
): Promise<void> => {
    const { attempts, watch, noResponse, endWait } = { ...DEFAULT_START_ATTEMPT_OPTIONS, ...options };

    const waitForLivestreamEnd = async (): Promise<boolean> => {
        for (let second = 0; second < endWait; second++) {
            if (!(await hooks.isStreaming(serial))) {
                return true;
            }
            await hooks.sleep(1000);
        }
        return false;
    };

    /** @returns true if the start failed and go2rtc still waits for it */
    const startFailed = async (): Promise<boolean> => {
        let streaming = false;
        for (let second = 1; second <= watch; second++) {
            await hooks.sleep(1000);
            if (hooks.cancelled() || !hooks.isWaiting(serial)) {
                // Arrived, or nobody waits for it anymore.
                return false;
            }
            const now = await hooks.isStreaming(serial);
            if (streaming && !now) {
                return true;
            }
            streaming ||= now;
            if (now && second >= noResponse) {
                hooks.log.info(`On-demand stream ${serial}: the camera did not answer within ${second} seconds`);
                await hooks.stop(serial).catch(() => {});
                return true;
            }
        }
        return false;
    };

    for (let attempt = 1; attempt <= attempts; attempt++) {
        if (!(await waitForLivestreamEnd())) {
            // Usually a livestream that was started through start_stream at the same time - its
            // start event hands it to go2rtc anyway.
            hooks.log.debug(`On-demand stream ${serial}: a livestream is already running`);
            return;
        }
        await hooks.start(serial);
        if (!(await startFailed())) {
            return;
        }
        const next = attempt < attempts ? ' - starting it again' : '';
        hooks.log.info(`On-demand stream ${serial}: the camera acknowledged the livestream but sent no data${next}`);
    }
    // Waking it again and again only keeps the station - and the other cameras of it - busy.
    hooks.log.warn(
        `On-demand stream ${serial}: the camera did not deliver in ${attempts} attempts - not starting it for a minute`,
    );
    hooks.markUnreachable(serial);
};
