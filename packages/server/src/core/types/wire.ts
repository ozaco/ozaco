import type { Meta } from './common'
import type { OutcomeState, Trace } from './trace'

/** The single wire spec: everything a remote carrier moves between nodes (types-only namespace). */
export namespace Wire {
  /**
   * A failure crossing any wire — carried with FULL fidelity everywhere: tag, message, the whole
   * cause chain (trace breadcrumbs included), halt flag, pre-set status and meta.
   */
  export interface Failure {
    /** The failure tag (string form). */
    readonly error: string
    readonly message: string
    readonly causes: readonly string[]
    readonly halted?: boolean | undefined
    readonly status?: number | undefined
    readonly meta?: Meta | undefined
  }

  /** Serializable manifest of the lanes a dispatch carries besides the value plane. */
  export interface LaneManifest {
    readonly streams: number
    readonly parts: boolean
  }

  /**
   * THE single wire spec. Every remote carrier (worker ports, NATS subjects) moves exactly these
   * envelopes, encoded through the routed std codec (JsonCodec baseline) — one codec, N carriers.
   */
  export type Envelope =
    | {
        readonly k: 'dispatch'
        readonly v: number
        readonly cid: string
        readonly service: string
        readonly action: string
        readonly trace: Trace
        readonly params?: unknown
        readonly meta?: Meta | undefined
        readonly idempotencyKey?: string | undefined
        readonly lanes?: LaneManifest | undefined
      }
    /** Owner received the dispatch and STARTED the handler — splits the timeout taxonomy. */
    | { readonly k: 'ack'; readonly cid: string }
    /** Owner-side final state, published even when the caller is already gone. */
    | { readonly k: 'outcome'; readonly cid: string; readonly outcome: OutcomeRecord }
    | {
        readonly k: 'reply'
        readonly cid: string
        readonly value: unknown
        readonly status?: number | undefined
        readonly meta?: Meta | undefined
      }
    | { readonly k: 'reply-failure'; readonly cid: string; readonly failure: Failure }
    /** Reply is a stream — the payload follows on the output lane. */
    | {
        readonly k: 'reply-stream'
        readonly cid: string
        readonly bytes: boolean
        readonly status?: number | undefined
        readonly meta?: Meta | undefined
      }
    | {
        readonly k: 'lane'
        readonly cid: string
        readonly lane: string
        readonly seq: number
        readonly data?: Uint8Array | undefined
        readonly end?: true | undefined
        readonly error?: Failure | undefined
      }
    | {
        readonly k: 'event'
        readonly name: string
        readonly payload: unknown
        readonly trace: Trace
        readonly scope: 'emit' | 'broadcast'
        readonly origin: string
      }
    | { readonly k: 'cancel'; readonly cid: string }
    /** Caller abandoned a DETACH dispatch — fire the handler's signal, never halt (req: remote detach visibility). */
    | { readonly k: 'abandoned'; readonly cid: string }
    /** Consumer-side flow control for carriers without native backpressure (worker ports). */
    | {
        readonly k: 'lane-credit'
        readonly cid: string
        readonly lane: string
        readonly grant: number
      }

  /** One multipart item as it travels over an input lane (both remote carriers share this). */
  export type PartFrame =
    | { readonly p: 'field'; readonly name: string; readonly value: string }
    | {
        readonly p: 'file'
        readonly name: string
        readonly filename: string
        readonly contentType: string
      }
    /** Belongs to the most recently opened file. */
    | { readonly p: 'chunk'; readonly data: Uint8Array }
    | { readonly p: 'file-end' }

  /** The serializable shape of an {@link Outcome} on the wire. */
  export interface OutcomeRecord {
    readonly cid: string
    readonly state: OutcomeState
    readonly ts: number
    readonly serviceId: string
    readonly actionId: string
    readonly error?: string | undefined
  }
}
