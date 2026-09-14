import type { CodecDef } from 'std:codec'
import type { Flow, Future, Operation } from 'std:effect'
import type { Plugin } from 'std:plugin'
import type { Result } from 'std:result'
import type { AnyType } from 'std:shared'

/**
 * `std:webrtc` — an effect-native WebRTC peer, the datagram counterpart to `std:ws`. `Rtc` is the
 * protocol (routed dispatch + hooks) and `RtcClient` its platform implementation. The same client
 * serves BOTH ends of a connection: `RTCPeerConnection` is peer-symmetric, so "client" and
 * "server" only differ in which implementation backs them. In the browser (and Deno) the platform
 * global is used; on Bun/Node the optional `node-datachannel` polyfill is auto-imported on first
 * use (install it next to `@ozaco/std`); anything else implements the `Rtc` protocol.
 *
 * Install `RtcClient` (optionally with default options), then `Rtc.actions.connect(signal, options)`
 * opens a peer RESOURCE bound to the caller's scope. Signaling (offer/answer/ICE) runs over the
 * given {@link RtcDef.SignalLike} duplex — a `Ws.actions.connect(...)` connection satisfies it
 * structurally — using the perfect-negotiation pattern (`polite` decides who yields on glare).
 * Everything is Flow-based: `peer.channels` streams remotely-opened channels, `peer.states`
 * streams connection-state transitions, and every data channel exposes one continuous `messages`
 * Flow plus a backpressure-aware `send` (parks while the SCTP buffer is above the high-water
 * mark). Framing matches `std:ws`: strings/binary pass as-is, other values go through the
 * registered `std:codec` — install a codec (e.g. `JsonCodec`) for structured values.
 */
export type RtcDef = Plugin<RtcDef.Context, [defaults?: RtcDef.Options], RtcDef.Contract>

export namespace RtcDef {
  // --- implementation subsets -----------------------------------------------------------------

  /** A session description in plain-JSON shape (what travels over the signal). */
  export interface DescriptionLike {
    type: 'offer' | 'answer' | 'pranswer' | 'rollback'
    sdp?: string | undefined
  }

  /** An ICE candidate in plain-JSON shape (what travels over the signal). */
  export interface CandidateLike {
    candidate?: string | undefined
    sdpMid?: string | null | undefined
    sdpMLineIndex?: number | null | undefined
    usernameFragment?: string | null | undefined
    toJSON?(): AnyType
  }

  /** The `RTCDataChannel` subset the browser and the `node-datachannel` polyfill both satisfy. */
  export interface ChannelLike {
    readonly label: string
    readonly readyState: 'connecting' | 'open' | 'closing' | 'closed'
    readonly bufferedAmount: number
    bufferedAmountLowThreshold: number
    binaryType: string

    send(data: string | ArrayBufferLike | ArrayBufferView): void
    close(): void

    onopen: ((event: AnyType) => void) | null
    onmessage: ((event: { data: AnyType }) => void) | null
    onbufferedamountlow: ((event: AnyType) => void) | null
    onerror: ((event: AnyType) => void) | null
    onclose: ((event: AnyType) => void) | null
  }

  /**
   * A media track in the impl's shape (`MediaStreamTrack` subset) — opaque to this module:
   * tracks are produced and consumed by platform APIs (`getUserMedia`, `<video>`), the plugin
   * only carries and negotiates them.
   */
  export interface TrackLike {
    readonly id: string
    /** `'audio' | 'video'` in practice (kept open — implementations vary). */
    readonly kind: string
    enabled?: boolean
    stop?(): void
  }

  /** A media stream in the impl's shape (`MediaStream` subset) — groups tracks for the remote. */
  export interface StreamLike {
    readonly id: string
    getTracks?(): TrackLike[]
  }

  /** An outgoing sender in the impl's shape (`RTCRtpSender` subset). */
  export interface SenderLike {
    readonly track: TrackLike | null
    replaceTrack?(track: TrackLike | null): Promise<void>
  }

  /** The `track` event subset (`RTCTrackEvent`). */
  export interface TrackEventLike {
    track: TrackLike
    streams?: StreamLike[]
  }

  /**
   * The `RTCStatsReport` subset — a Map-like bag of `{ id, type, … }` entries. Read through
   * `peer.stats()`, which normalizes it into a {@link RtcDef.Stats} snapshot.
   */
  export interface StatsReportLike {
    forEach(callback: (entry: AnyType, id?: AnyType) => void): void
  }

  /** The `RTCPeerConnection` subset the browser and the `node-datachannel` polyfill both satisfy. */
  export interface PeerLike {
    readonly connectionState: string
    readonly signalingState: string
    readonly localDescription: DescriptionLike | null
    readonly remoteDescription: DescriptionLike | null

    createOffer(options?: { iceRestart?: boolean }): Promise<DescriptionLike>
    createAnswer(): Promise<DescriptionLike>
    setLocalDescription(description?: DescriptionLike): Promise<void>
    setRemoteDescription(description: DescriptionLike): Promise<void>
    addIceCandidate(candidate?: CandidateLike | null): Promise<void>
    createDataChannel(label: string, options?: ChannelInit): ChannelLike
    close(): void

    /** MEDIA (optional — not every implementation has it; `addTrack` raises
     * `RtcErrors.Unsupported` when absent). The browser has the full set; the node-datachannel polyfill's media surface
     * is limited/experimental. */
    addTrack?(track: TrackLike, ...streams: StreamLike[]): SenderLike
    removeTrack?(sender: SenderLike): void
    getSenders?(): SenderLike[]

    /** OBSERVABILITY (optional): the live statistics report. `peer.stats()` raises
     * `RtcErrors.Unsupported` when the implementation has none. */
    getStats?(): Promise<StatsReportLike>

    onnegotiationneeded: (() => void) | null
    onicecandidate: ((event: { candidate: CandidateLike | null }) => void) | null
    onconnectionstatechange: ((event?: AnyType) => void) | null
    ondatachannel: ((event: { channel: ChannelLike }) => void) | null
    ontrack?: ((event: TrackEventLike) => void) | null
  }

  /** The peer-connection constructor shape `RtcClient` resolves at connect time (the platform
   * global, else the `node-datachannel` polyfill on Bun/Node); a mock implements the `Rtc`
   * protocol itself — see `tests/webrtc/fake.ts`. */
  export type ImplLike = new (configuration?: Configuration) => PeerLike

  /** An `RTCConfiguration` subset; extra impl-specific keys pass through untouched. */
  export interface Configuration extends Record<string, AnyType> {
    iceServers?: IceServer[] | undefined
  }

  export interface IceServer {
    urls: string | string[]
    username?: string | undefined
    credential?: string | undefined
  }

  // --- signaling --------------------------------------------------------------------------------

  /**
   * The out-of-band signaling duplex the peers exchange offers/answers/candidates over. Any
   * `{ send, messages }` pair qualifies — a `WsDef.Connection` satisfies it structurally, so a
   * `Ws.actions.connect(...)` result can be passed directly. The peer OWNS the flow: it forks a
   * pump that consumes `messages` for the connection's lifetime (non-`rtc:*` frames are ignored,
   * so keepalive frames are safe — but other traffic on a shared socket needs a user-side demux).
   */
  export interface SignalLike {
    send(data: unknown): Operation<void>
    readonly messages: Flow<unknown, AnyType>
  }

  /** `rtc:description` — an offer/answer travelling over the signal. */
  export interface DescriptionFrame {
    t: 'rtc:description'
    description: DescriptionLike
  }

  /** `rtc:candidate` — a (possibly end-of-candidates `null`) ICE candidate over the signal. */
  export interface CandidateFrame {
    t: 'rtc:candidate'
    candidate: CandidateLike | null
  }

  /** `rtc:bye` — the remote peer closed deliberately; this end settles cleanly. */
  export interface ByeFrame {
    t: 'rtc:bye'
  }

  export type SignalFrame = DescriptionFrame | CandidateFrame | ByeFrame

  // --- options ----------------------------------------------------------------------------------

  /**
   * ICE-restart budget. Present (even `{}`) = supervised restarts on `failed`; absent = a failed
   * connection settles with `RtcErrors.Connection`.
   */
  export interface IceRestartOptions {
    /** Max restart offers per outage (default `5`). The budget RESETS after a successful recovery,
     * so only consecutive failed restarts count toward exhaustion. */
    retries?: number | undefined

    /** Delay before checking the first restart's outcome, in ms (default `250`). */
    delayMs?: number | undefined

    /** Exponential multiplier applied per failed attempt: attempt `n` waits
     * `delayMs * backoff^n` (default `1` — constant delay). */
    backoff?: number | undefined

    /** Upper bound for the computed delay in ms (default `30_000`). */
    maxDelayMs?: number | undefined
  }

  /**
   * Session-redial budget. Present (even `{}`) = a DEAD connection (failure, ICE exhaustion,
   * impl close) is redialed as a whole NEW generation over the same signal: locally-opened
   * channels are recreated and rebound (their handles and flows continue), the remote peer's
   * channels close cleanly and fresh ones re-emit on `channels`. A remote `rtc:bye`, a local
   * `close()`, and a dead signal are never redialed. Absent = the first dead connection settles
   * the peer. The WebRTC counterpart of `WsDef.ReconnectOptions`.
   */
  export interface ReconnectOptions {
    /** Max redial attempts per outage (default `5`). The budget RESETS after a successful
     * recovery, so only consecutive failed redials count toward exhaustion. */
    retries?: number | undefined

    /** Delay before the first redial of an outage, in ms (default `250`). Each dialed attempt
     * also gets one extra step of the same length as a connect grace window. */
    delayMs?: number | undefined

    /** Exponential multiplier applied per failed attempt: attempt `n` waits
     * `delayMs * backoff^n` (default `1` — constant delay). */
    backoff?: number | undefined

    /** Upper bound for the computed delay in ms (default `30_000`). */
    maxDelayMs?: number | undefined
  }

  /**
   * Observability knobs. Counters ({@link RtcDef.Metrics}) and the timeline are always on — they
   * are a handful of integers and a bounded array; this only sizes them.
   */
  export interface ObserveOptions {
    /** How many timeline entries `peer.timeline` keeps (ring buffer, oldest dropped; default
     * `128`, `0` keeps none — `peer.events` still streams every entry live). */
    timeline?: number | undefined

    /** Sample `peer.stats()` every N ms and record it as a `stats` timeline entry whose `data`
     * carries the flattened numbers (default `0` — no sampler). */
    sampleMs?: number | undefined
  }

  /** The `RTCDataChannel` init subset forwarded to `createDataChannel`. */
  export interface ChannelInit {
    /** Guarantee in-order delivery (default `true`). */
    ordered?: boolean | undefined

    /** Max retransmissions before giving up (unreliable mode; exclusive with `maxPacketLifeTime`). */
    maxRetransmits?: number | undefined

    /** Max ms to attempt retransmission (unreliable mode; exclusive with `maxRetransmits`). */
    maxPacketLifeTime?: number | undefined

    /** Application sub-protocol tag carried in the channel handshake. */
    protocol?: string | undefined
  }

  export interface ChannelOptions extends ChannelInit {
    /** `send` parks while `bufferedAmount` exceeds this many bytes (default `1_048_576`). */
    highWaterMark?: number | undefined

    /** `bufferedAmountLowThreshold` — parked sends resume once the buffer drains below this
     * (default `262_144`). */
    lowWaterMark?: number | undefined

    /** Max ms a LOCAL `channel()` call waits for the channel to open before failing
     * `RtcErrors.Timeout` (default `10_000`; `0` disables). Local channels only: remote channels
     * (emitted on `channels`) have no open deadline. */
    openTimeoutMs?: number | undefined
  }

  export interface Options {
    /** Perfect-negotiation role: the polite peer rolls back and yields on offer glare. Exactly ONE
     * side should be `true` when both sides may (re)negotiate concurrently (default `false` —
     * fine when only this side opens channels). */
    polite?: boolean | undefined

    /** STUN/TURN servers for the peer connection. */
    iceServers?: IceServer[] | undefined

    /** Extra `RTCConfiguration` passed through to the implementation untouched. */
    configuration?: Configuration | undefined

    /** Supervised ICE restarts on `connectionState: 'failed'`. Omit for single-shot behavior
     * (a failed connection settles every flow with `RtcErrors.Connection`). */
    iceRestart?: IceRestartOptions | undefined

    /** Session-level redial of a DEAD connection over the same signal (the `Ws`-style reconnect;
     * `iceRestart` recovers a LIVING connection in place, this replaces a dead one). Closes with
     * `RtcErrors.ReconnectExhausted` when the budget runs out. */
    reconnect?: ReconnectOptions | undefined

    /** Defaults for every `channel()` call (shallow-merged under per-call options). Also applied
     * to REMOTE channels emitted on `channels` (water marks, wire init) — except `openTimeoutMs`,
     * which only bounds local `channel()` calls. */
    channel?: ChannelOptions | undefined

    /** Preferred codec for frame (de)serialization — same semantics as `WsDef.Options.codec`:
     * pins the dispatch to this impl instead of the routed `Codec` protocol; the impl must still
     * be installed in scope. */
    codec?: CodecDef | undefined

    /** Sizes the always-on observability surface (`peer.metrics` / `peer.timeline` /
     * `peer.events`) and optionally turns the `getStats` sampler on. */
    observe?: ObserveOptions | undefined
  }

  // --- handles ----------------------------------------------------------------------------------

  /**
   * The close value flows settle with: `true` on a clean end, or a failure. The session-level
   * tags a failure close carries (all from `RtcErrors`, exported by `std:webrtc`; values are
   * dotted, e.g. `'std:webrtc.timeout'`): `RtcErrors.Connection` (the connection `failed` with no
   * `iceRestart`, or the impl closed it under `reconnect`), `RtcErrors.IceExhausted` (the restart
   * budget ran out), `RtcErrors.ReconnectExhausted` (the redial budget ran out),
   * `RtcErrors.Negotiation` (an offer/answer step failed — `createOffer`/`createAnswer`,
   * `setLocalDescription`/`setRemoteDescription`, or the signal `send` of an answer), and
   * `RtcErrors.Signal` (the signal flow closed before the connection reached `connected`).
   * Per-channel failures close with `RtcErrors.Channel` (a channel-level `error` preceded the
   * close).
   */
  export type FlowClose = true | Result.Failure<unknown>

  /** Why/how the peer permanently ended. */
  export interface CloseInfo {
    /** The final `connectionState` observed. */
    state: string

    /** `'client'` (local `close()`), `'scope closed'`, `'bye'` (remote close), `'failed'`,
     * `'ice-exhausted'`, `'reconnect-exhausted'`, `'negotiation'`, `'signal'` (signal flow ended
     * mid-negotiation), or `'closed'` (impl-initiated). */
    reason: string
  }

  /**
   * A live data channel. Local channels (`peer.channel(...)`) are RESOURCES bound to the caller's
   * scope; remote channels (from `peer.channels`) live until the peer ends or `close()` is called.
   */
  export interface Channel {
    /** The underlying platform channel (escape hatch). */
    readonly native: ChannelLike
    readonly label: string
    readonly readyState: ChannelLike['readyState']

    /** Send a frame — strings/binary as-is, every other value encoded through the registered
     * codec. Parks while the channel is still connecting OR while `bufferedAmount` is above the
     * high-water mark (backpressure); on a closed channel it is a silent no-op (WHATWG discard). */
    send(data: unknown): Operation<void>

    /** Incoming frames as ONE continuous effect Flow (codec-decoded on pull, buffered until
     * consumed; single consumer). Closes `true` on a clean end or with the peer's failure close. */
    readonly messages: Flow<unknown, FlowClose>

    /** Close this channel (the peer stays up); resolves once fully closed. */
    close(): Operation<void>

    /** Resolves with the channel's final close value once it permanently ends. */
    readonly closed: Future<FlowClose>
  }

  /**
   * A live outgoing media sender — a RESOURCE in the caller's scope (closing the scope removes
   * the track and renegotiates), and a SESSION-STABLE handle: under `reconnect` the track is
   * automatically re-added on every redialed generation (the impl sender underneath is
   * replaced).
   */
  export interface Sender {
    /** The current generation's impl sender (escape hatch; replaced after a redial, `undefined`
     * through a redial gap). */
    readonly native: SenderLike | undefined

    /** The outgoing track (the latest `replace()`d one). */
    readonly track: TrackLike | null

    /** Swap the outgoing track in place — no renegotiation when the kinds match; `null` mutes.
     * Requires the impl's `replaceTrack` (raises `RtcErrors.Unsupported` otherwise); raises
     * `RtcErrors.Track` when the sender is already removed / the peer ended, or `replaceTrack`
     * rejects. */
    replace(track: TrackLike | null): Operation<void>

    /** Stop sending for good: `removeTrack` + renegotiation. Idempotent. */
    remove(): Operation<void>
  }

  /** A track announced by the remote peer (their `addTrack` after negotiation). */
  export interface IncomingTrack {
    track: TrackLike
    streams: StreamLike[]
  }

  // --- observability ----------------------------------------------------------------------------

  /**
   * What a timeline entry is about. `dial` = a fresh connection was constructed (generation),
   * `state` = a `connectionState` transition, `offer`/`answer` = one leg of a negotiation round,
   * `glare` = simultaneous offers resolved, `candidate` = an ICE candidate crossed the signal,
   * `channel`/`track` = a data channel or media track appeared, `ice-restart`/`redial` = the
   * supervisors at work, `stats` = a sampler snapshot, `close` = the session ended, `error` = a
   * step failed.
   */
  export type EventKind =
    | 'dial'
    | 'state'
    | 'offer'
    | 'answer'
    | 'glare'
    | 'candidate'
    | 'channel'
    | 'track'
    | 'ice-restart'
    | 'redial'
    | 'stats'
    | 'close'
    | 'error'

  /**
   * One thing that happened, in order — the peer's trace. Entries are recorded whether or not
   * anyone is listening (into the bounded `peer.timeline`) and broadcast live on `peer.events`.
   */
  export interface Event {
    /** epoch ms (`Date.now()`) when it was recorded. */
    at: number
    /** which connection generation it belongs to (1-based; a redial opens the next one). */
    generation: number
    kind: EventKind

    /** the specifics: the state name, `out:chat` / `in:video`, `out:host` / `in:relay`,
     * `attempt 2`, the close reason… */
    detail?: string | undefined
    /** how long the step took, when it is a step: a negotiation round, a restart, a redial. */
    durationMs?: number | undefined
    /** the failure tag when the step failed. */
    error?: string | undefined
    /** flattened numbers that belong to the entry (a `stats` sample carries its snapshot here). */
    data?: Readonly<Record<string, number | string | boolean>> | undefined
  }

  /**
   * Cheap always-on counters for the whole session (they survive redials — a redial bumps
   * `generations`, it does not reset anything).
   */
  export interface Metrics {
    /** this peer session's id — both ends report their own; correlate on your own key. */
    id: string
    /** epoch ms when `connect()` ran. */
    startedAt: number
    /** ms from `connect()` to the FIRST `connected` state (absent while never connected). */
    connectedMs?: number | undefined
    /** the current `connectionState`. */
    state: string

    /** connections CONSTRUCTED: the first dial plus every redial attempt (a redial that needed
     * three attempts to stick counts three). */
    generations: number
    /** offer rounds this side drove to completion. */
    negotiations: number
    offersSent: number
    offersReceived: number
    answersSent: number
    answersReceived: number
    /** offer glare, counted from BOTH directions: a remote offer that arrived while ours was in
     * flight (ignored as the impolite side, rolled into as the polite one) PLUS our own offers
     * deferred because a remote offer already held the floor. */
    glare: number
    candidatesSent: number
    candidatesReceived: number

    /** recoveries through a supervised ICE restart / a session redial. */
    restarts: number
    reconnects: number

    /** channels this side opened / the remote announced. */
    channelsOpened: number
    channelsAccepted: number
    messagesSent: number
    messagesReceived: number
    /** approximate payload volume: exact for binary frames, character count for text ones (the
     * exact wire numbers live in `peer.stats()`'s data-channel entries). */
    bytesSent: number
    bytesReceived: number
    tracksSent: number
    tracksReceived: number

    /** failed steps: a `failed` connection state, a failed negotiation step, or a peer
     * construction that threw. An exhausted `iceRestart` / `reconnect` budget settles the session
     * (`RtcErrors.IceExhausted` / `RtcErrors.ReconnectExhausted`) but does NOT count here. */
    failures: number
  }

  /** The selected ICE candidate pair — how the media actually flows. */
  export interface PairStats {
    /** candidate types (`host` · `srflx` — through STUN · `relay` — through TURN). */
    local?: string | undefined
    remote?: string | undefined
    /** current round-trip time in ms. */
    rttMs?: number | undefined
    /** the impl's outgoing bandwidth estimate, bits per second. */
    outgoingBitrate?: number | undefined
    bytesSent?: number | undefined
    bytesReceived?: number | undefined
  }

  /** One RTP stream (a track in flight). */
  export interface MediaStats {
    /** `'audio' | 'video'` in practice. */
    kind: string
    bytes?: number | undefined
    packets?: number | undefined
    packetsLost?: number | undefined
    jitterMs?: number | undefined
    /** frames decoded (inbound) / sent (outbound). */
    frames?: number | undefined
    fps?: number | undefined
    width?: number | undefined
    height?: number | undefined
  }

  /** One data channel as the implementation counts it (exact wire numbers). */
  export interface ChannelStats {
    label: string
    state?: string | undefined
    messagesSent?: number | undefined
    messagesReceived?: number | undefined
    bytesSent?: number | undefined
    bytesReceived?: number | undefined
  }

  /**
   * A normalized `getStats()` snapshot — the impl-specific report reduced to the numbers that
   * mean something to a call.
   */
  export interface Stats {
    /** epoch ms the snapshot was taken. */
    at: number
    state: string
    /** transport totals, when the implementation reports them. */
    bytesSent?: number | undefined
    bytesReceived?: number | undefined
    pair?: PairStats | undefined
    inbound: MediaStats[]
    outbound: MediaStats[]
    channels: ChannelStats[]
  }

  // --- the peer ---------------------------------------------------------------------------------

  /**
   * A live peer connection — a RESOURCE: it lives until the scope that called `connect` closes, at
   * which point a `bye` is signalled, the connection closes, and every channel/pump is torn down.
   */
  export interface Peer {
    /** The underlying platform peer connection (escape hatch — `addTrack` and friends live here;
     * media renegotiation is forwarded when the impl fires `negotiationneeded`). */
    readonly native: PeerLike
    readonly connectionState: string
    readonly signalingState: string
    /** How many times the connection recovered through a supervised ICE restart. */
    readonly restarts: number
    /** How many times the connection recovered through a session redial (`reconnect`). */
    readonly reconnects: number

    /** Open a data channel bound to the caller's scope; resolves once the channel is OPEN (first
     * channel drives the initial offer/answer; later ones open in-band without renegotiation).
     * Raises `RtcErrors.Channel` when the peer is already closed, `createDataChannel` throws, or
     * the channel closes (or the session settles) before it opens; `RtcErrors.Timeout` when it
     * is not open within `openTimeoutMs`. */
    channel(label: string, options?: ChannelOptions): Operation<Channel>

    /** Channels the REMOTE peer opens, as an effect Flow (each already open when emitted; single
     * consumer). Closes with the peer's final close value. */
    readonly channels: Flow<Channel, FlowClose>

    /** Start sending a media track (browser-first: the impl must expose `addTrack`, else
     * `RtcErrors.Unsupported`); drives renegotiation and resolves with a session-stable
     * {@link Sender}. Raises `RtcErrors.Track` when the peer is already closed or the impl's
     * `addTrack` throws. Under `reconnect` the track is re-added on every redialed generation. */
    addTrack(track: TrackLike, ...streams: StreamLike[]): Operation<Sender>

    /** Tracks the REMOTE peer announces, as an effect Flow (single consumer). Like remote
     * channels, announcements are per generation: after a redial the remote's re-added tracks
     * re-emit here. Closes with the peer's final close value. */
    readonly tracks: Flow<IncomingTrack, FlowClose>

    /** `connectionState` transitions as an effect Flow (single consumer). */
    readonly states: Flow<string, FlowClose>

    /** Queue an ICE restart offer manually (also driven automatically by `iceRestart`). A silent
     * no-op without a live generation — never dialed, mid-redial gap, or already ended. */
    restartIce(): Operation<void>

    /** Close the peer for good: signal `rtc:bye`, close the connection, settle every flow. */
    close(): Operation<void>

    /** Resolves once the peer permanently ends. */
    readonly closed: Future<CloseInfo>

    /** This session's id — stamped on `metrics` so reports from both ends stay apart. */
    readonly id: string

    /** A snapshot of the always-on session counters (see {@link RtcDef.Metrics}). */
    readonly metrics: Metrics

    /** The last N things that happened, oldest first (bounded by `observe.timeline`). Read it
     * after a failure and the whole negotiation is right there. */
    readonly timeline: readonly Event[]

    /** The same entries live, as an effect Flow. Multi-subscriber and lossy by design: entries
     * sent while nobody is subscribed are dropped (the timeline keeps them). */
    readonly events: Flow<Event, FlowClose>

    /** Read + normalize the implementation's `getStats()` report. Raises `RtcErrors.Unsupported`
     * when the impl has no `getStats`; `RtcErrors.Stats` when the call itself rejects OR when
     * there is no live generation to read from (never connected, mid-redial gap, or ended). */
    stats(): Operation<Stats>
  }

  /**
   * The installed client context: install-time defaults, merged (shallow, per top-level key)
   * under each `connect` call's own options.
   */
  export interface Context {
    defaults: Options
  }

  /** The action contract `Rtc` routes and `RtcClient` implements. */
  export interface Contract {
    /** Open a peer connection bound to the caller's scope, negotiating over `signal`. Resolves
     * immediately with the peer handle (channels connect lazily), or raises
     * `RtcErrors.Unsupported` (no `RTCPeerConnection` global and no `node-datachannel` polyfill) /
     * `RtcErrors.Connect` (the implementation refused the configuration). */
    connect(signal: SignalLike, options?: Options): Operation<Peer>
  }
}
