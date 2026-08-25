import type { CodecDef } from 'std:codec'
import type { Flow, Operation, Queue } from 'std:effect'

import type { RtcDef } from './rtc'

/**
 * The peer's PRIVATE vocabulary — the shapes `internal/*` hands each other while it drives one
 * session. None of it travels the wire and none of it is what a consumer speaks: that is
 * {@link RtcDef}. It lives here so the internals stay free of type declarations.
 */
export namespace Helpers {
  /** Counters + timeline + the live event flow of ONE peer session. The peer mutates `counters`
   * in place (it runs inside impl event handlers, so recording must never yield). */
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

  /** Fully-resolved retry settings (absent entirely when that supervision is disabled). */
  export interface Budget {
    retries: number
    delayMs: number
    backoff: number
    maxDelayMs: number
  }

  /** Why an offer was queued: `channel` kicks are skipped once the SCTP association exists (later
   * channels open in-band without SDP), `needed` (impl-fired renegotiation via the native escape
   * hatch) is skipped mid-negotiation, `track` (media added/removed) and `restart` always
   * negotiate. */
  export interface NegotiationRequest {
    kind: 'channel' | 'needed' | 'restart' | 'track'
  }

  /** One native connection's lifetime. Session `reconnect` replaces a dead generation with a
   * fresh one over the SAME signal; everything session-scoped (channel handles,
   * `channels`/`states` flows, `closed`) survives the swap. */
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
}
