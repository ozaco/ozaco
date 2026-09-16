import type { CodecDef } from 'std:codec'
import type { Flow, Helpers as EffectHelpers, Operation, Queue, Utils } from 'std:effect'
import type { Result } from 'std:result'

import type { RtcDef } from './rtc'

/**
 * The peer's PRIVATE vocabulary — the shapes `internal/*` hands each other while it drives one
 * session. None of it travels the wire and none of it is what a consumer speaks: that is
 * {@link RtcDef}. It lives here so the internals stay free of type declarations.
 */
export namespace Helpers {
  /**
   * Counters + timeline + the live event flow of ONE peer session. The peer mutates `counters`
   * in place (it runs inside impl event handlers, so recording must never yield).
   */
  export interface Observer {
    readonly id: string
    /** live counters — mutated in place by the peer, snapshotted through `metrics()`. */
    readonly counters: RtcDef.Metrics
    /** the generation every entry is stamped with (the peer bumps it on each dial). */
    generation: number
    readonly events: Flow<RtcDef.Event, RtcDef.FlowClose>

    record(kind: RtcDef.EventKind, detail?: string, extra?: Partial<RtcDef.Event>): void
    timeline(): readonly RtcDef.Event[]
    metrics(state: string): RtcDef.Metrics
    /** settle the live flow with the session's close value (the timeline stays readable). */
    close(close: RtcDef.FlowClose): void
  }

  /** A wrapped channel plus the peer-facing controls that never leave the module. */
  export interface ChannelEntry {
    handle: RtcDef.Channel
    /** Resolves once the channel FIRST opens; raises `rtc/channel` if it closes before opening. */
    opened: Operation<void>

    /** Force-end from the peer (settle/teardown): close the native channel, settle every flow. */
    end(close: RtcDef.FlowClose): void
    /** Detach from a dead generation's native WITHOUT settling (session redial): unhooks the old
     * native and parks senders until `rebind`. */
    suspend(): void
    /** Attach a fresh native from a redialed generation — the SAME handle and flows continue. */
    rebind(native: RtcDef.ChannelLike): void
  }

  /** What the PEER hands its channels: framing, redial policy, and the session's observer. */
  export interface ChannelWiring {
    /** Pinned codec for frame (de)serialization (the routed `Codec` protocol otherwise). */
    codec?: CodecDef | undefined
    /** May a dying native be held for a rebind instead of settling (session redial in flight)? */
    retain?: (() => boolean) | undefined
    /** The peer's observer — message/byte counters are incremented on the wire path. */
    observe?: Observer | undefined
  }

  /**
   * Why an offer was queued: `channel` kicks are skipped once the SCTP association exists (later
   * channels open in-band without SDP), `needed` (impl-fired renegotiation via the native escape
   * hatch) is skipped mid-negotiation, `track` (media added/removed) and `restart` always
   * negotiate.
   */
  export interface NegotiationRequest {
    kind: 'channel' | 'needed' | 'restart' | 'track'
  }

  /**
   * One native connection's lifetime. Session `reconnect` replaces a dead generation with a
   * fresh one over the SAME signal; everything session-scoped (channel handles,
   * `channels`/`states` flows, `closed`) survives the swap.
   */
  export interface Generation {
    pc: RtcDef.PeerLike
    alive: boolean

    /** offer requests, serialized through ONE supervisor so SDP operations never interleave */
    negotiations: Queue<NegotiationRequest, void>
    /** each `failed` transition lands here for the ICE-restart supervisor */
    outages: Queue<string, void>
    /** locally-gathered candidates; pumped out as frames (signal.send is an Operation — it cannot
     * run inside the synchronous event handler) */
    candidatesOut: Queue<RtcDef.CandidateLike | null, void>
    /** natives announced by the remote peer, wrapped by the incoming pump */
    incoming: Queue<RtcDef.ChannelLike, void>

    // perfect-negotiation bookkeeping
    makingOffer: boolean
    ignoreOffer: boolean
    settingRemoteAnswer: boolean
    /** Swallow the impl's next `negotiationneeded` when WE just queued a channel kick. */
    kicked: boolean
    /** Remote candidates buffered until a remote description is in place. */
    pendingCandidates: (RtcDef.CandidateLike | null)[]
  }

  /** A locally-opened channel: recreated by label+options on every redialed generation. */
  export interface LocalRecord {
    entry: ChannelEntry
    label: string
    options: RtcDef.ChannelOptions
  }

  /** A locally-added media track: re-added on every redialed generation until removed. */
  export interface TrackRecord {
    track: RtcDef.TrackLike | null
    streams: RtcDef.StreamLike[]
    /** The CURRENT generation's impl sender (undefined through a redial gap). */
    sender: RtcDef.SenderLike | undefined
    removed: boolean
  }

  /**
   * ONE peer session — the spine every internal shares. Generations come and go underneath it
   * (`generation` is the CURRENT one); the queues, records, observer, and `closed` are
   * session-scoped and survive redials. `settle` is the single permanent-end path.
   */
  export interface Session {
    readonly signal: RtcDef.SignalLike
    readonly options: RtcDef.Options
    readonly polite: boolean
    /** Resolved ICE-restart budget — absent when restarts are unsupervised. */
    readonly restart: Utils.Budget | undefined
    /** Resolved session-redial budget — absent when a dead connection settles the peer. */
    readonly reconnect: Utils.Budget | undefined

    readonly observe: Observer
    /** `observe.counters` — the same object, kept short because every pump touches it. */
    readonly counters: RtcDef.Metrics

    /** remote-opened channels, already OPEN when emitted (see the incoming pump) */
    readonly channels: Queue<RtcDef.Channel, RtcDef.FlowClose>
    /** connectionState transitions for the `states` flow (continuous across generations) */
    readonly states: Queue<string, RtcDef.FlowClose>
    /** tracks the remote announces, for the `tracks` flow (continuous across generations) */
    readonly tracks: Queue<RtcDef.IncomingTrack, RtcDef.FlowClose>
    /** generation deaths, one at a time, for the session-reconnect supervisor */
    readonly outages: Queue<Result.Failure<unknown>, void>
    /** Resolves with the final close info once the peer permanently ends. */
    readonly closed: EffectHelpers.FutureWithResolvers<RtcDef.CloseInfo>

    /** locally-opened channels (rebound on redial) */
    readonly localRecords: Set<LocalRecord>
    /** live remote entries (per generation) */
    readonly remoteEntries: Set<ChannelEntry>
    /** locally-added media tracks (re-added on redial until removed) */
    readonly trackRecords: Set<TrackRecord>

    /** Permanently ended: every queue is closed and `closed` is resolved. */
    ended: boolean
    /** `close()` was called (or the scope tore down) — never redial past this point. */
    closedByClient: boolean
    /** The signal flow ended — negotiation (and therefore any redial) is impossible. */
    signalEnded: boolean
    generation: Generation | undefined

    /** The current `connectionState` (`'closed'` without a live generation). */
    stateOf(): string
    /** May the channel layer hold a dying native for a rebind instead of settling? */
    retainLocal(): boolean
    /** The gate `channel()` calls and the per-generation pumps park on through a redial gap;
     * notified on every dial and on the permanent end. */
    readonly dial: Utils.Gate

    sendFrame(frame: RtcDef.SignalFrame): Operation<void>
    /** Count every candidate; record the first of each type per generation and direction. */
    noteCandidate(direction: 'in' | 'out', candidate: RtcDef.CandidateLike | null): void

    /** Stop ONE generation: unhook, close its queues (pumps drain out), close the native. */
    teardownGeneration(generation: Generation): void
    /** Permanent end — runs at most once. */
    settle(close: RtcDef.FlowClose, info: RtcDef.CloseInfo): void
    /** A generation died mid-flight: tear it down, then redial (under `reconnect`) or settle. */
    endGeneration(
      generation: Generation,
      failure: Result.Failure<unknown>,
      info: RtcDef.CloseInfo,
    ): void

    /** Park until a live generation exists (returns it), or the session ends (undefined). */
    awaitGeneration(): Operation<Generation | undefined>
    /** Run `body` once per live generation, in dial order, until the session ends. `body` must
     * return when its generation dies (every per-generation queue closes on teardown). */
    eachGeneration(body: (generation: Generation) => Operation<void>): Operation<void>
  }
}
