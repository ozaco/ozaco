import type { CodecDef } from 'std:codec'
import type { Flow, Future, Operation } from 'std:effect'
import type { Plugin } from 'std:plugin'
import type { Result } from 'std:result'
import type { AnyType } from 'std:shared'

/**
 * `std:ws` — an effect-native WebSocket CLIENT plugin, the socket counterpart to `std:fetch`.
 * Install `Ws` (optionally with default options), then `Ws.actions.connect(url, options)` opens a
 * connection RESOURCE bound to the caller's scope: when the scope closes, the socket closes and
 * every background pump is torn down — no manual `close()` needed (it stays available). With
 * `reconnect` configured, dropped sockets are redialed in the background and every socket
 * generation feeds the same continuous `messages` flow. Framing mirrors the server gateway's WS
 * handling and, like `std:fetch`, runs through the registered `std:codec`: strings/binary go
 * as-is, every other value is codec-encoded on send + codec-decoded on receive. A codec (e.g.
 * `JsonCodec`) must be installed in scope for structured values.
 */
export type WsDef = Plugin<WsDef.Context, [defaults?: WsDef.Options], WsDef.Actions>

export namespace WsDef {
  /** The WHATWG WebSocket subset the browser / Bun / Node global `WebSocket` all satisfy. */
  export interface SocketLike {
    send(data: string | ArrayBufferLike | ArrayBufferView): void
    close(code?: number, reason?: string): void
    readonly readyState: number
    /** How binary frames surface. `connect` forces `'arraybuffer'` so binary arrives as `ArrayBuffer`
     * (the default `'blob'` would yield `Blob` in the browser). */
    binaryType: 'blob' | 'arraybuffer'
    onopen: ((event: AnyType) => void) | null
    onmessage: ((event: { data: AnyType }) => void) | null
    onerror: ((event: AnyType) => void) | null
    onclose: ((event: { code?: number; reason?: string }) => void) | null
  }

  /** The WebSocket constructor `connect` dispatches through (injectable via `wsImpl`). Accepts the
   * standard `protocols` second arg OR the Bun/Node options-object form (`{ headers, protocols }`). */
  export type Ctor = new (
    url: string | URL,
    options?:
      | string
      | string[]
      | { protocols?: string | string[]; headers?: Record<string, string> },
  ) => SocketLike

  /** Auto-reconnect budget. Present (even `{}`) = reconnect enabled; absent = single-shot socket. */
  export interface ReconnectOptions {
    /** Max redial attempts per outage (default `5`). The budget RESETS after a successful reopen,
     * so only consecutive failed redials count toward exhaustion. */
    retries?: number | undefined
    /** Delay before the first redial of an outage, in ms (default `250`). */
    delayMs?: number | undefined
    /** Exponential multiplier applied per failed attempt: attempt `n` waits
     * `delayMs * backoff^n` (default `1` — constant delay). */
    backoff?: number | undefined
    /** Upper bound for the computed delay in ms (default `30_000`). */
    maxDelayMs?: number | undefined
  }

  /** Periodic keepalive frames, sent only while the socket is OPEN. */
  export interface KeepaliveOptions {
    /** Interval between keepalive frames in ms (default `30_000`). */
    intervalMs?: number | undefined
    /** The frame to send — goes through the normal codec framing, so strings pass as-is and
     * structured values are codec-encoded (default `'ping'`). */
    payload?: unknown
  }

  export interface Options {
    /** Sub-protocol(s) offered on the handshake. */
    protocols?: string | string[] | undefined
    /** Handshake headers, e.g. `{ authorization: 'Bearer …' }`. Honored by Bun's and Node's global
     * `WebSocket` (passed as the options-object constructor form); the browser `WebSocket` cannot set
     * handshake headers — use a `?token=` query param there, matching the gateway's `wsBearer`. */
    headers?: Record<string, string> | undefined
    /** Redial dropped sockets automatically. Applies to server-initiated closes and errors — never
     * to client `close()` or scope teardown. Omit for the classic single-shot socket. */
    reconnect?: ReconnectOptions | undefined
    /** Send periodic keepalive frames while OPEN. Off unless configured. */
    keepalive?: KeepaliveOptions | undefined
    /** Preferred codec for frame (de)serialization: a specific codec impl whose pinned actions are
     * used instead of the routed `Codec` protocol (which picks the highest-priority install). Set
     * it install-wide via `install(Ws, { codec })` (defaults merge under each connect's options) or
     * per connection; the impl must still be installed in scope — pinned dispatch fails
     * `missing-action` otherwise. */
    codec?: CodecDef | undefined
  }

  /** The close value the message stream settles with: `true` on a permanent clean close, or a
   * failure — e.g. `'ws/reconnect-exhausted'` when the reconnect budget ran out. */
  export type FlowClose = true | Result.Failure<unknown>

  /** Why/how the socket closed. */
  export interface CloseInfo {
    code: number
    reason: string
  }

  /**
   * A live connection — a RESOURCE: it lives until the scope that called `connect` closes, at
   * which point the socket is closed and every pump/supervisor is torn down automatically.
   */
  export interface Connection {
    /** The underlying platform socket (escape hatch). With reconnect enabled this is the CURRENT
     * generation — it is replaced after every successful redial. */
    readonly native: SocketLike
    readonly url: string
    /** Current `readyState` (0 CONNECTING · 1 OPEN · 2 CLOSING · 3 CLOSED). */
    readonly readyState: number
    /** How many times the connection successfully reopened after a drop. */
    readonly reconnects: number
    /** Send a frame — strings/binary as-is, every other value encoded through the registered codec.
     * During a reconnect window the send parks until the socket reopens (bounded by the reconnect
     * budget); on a permanently closed connection it is a silent no-op (WHATWG discard). */
    send(data: unknown): Operation<void>
    /** Incoming frames as ONE continuous effect Flow across reconnects (codec-decoded on pull,
     * buffered until consumed). Closes only on permanent end: `true` after a clean client close or
     * an unreconnected server close, or a failure (e.g. `'ws/reconnect-exhausted'`). */
    readonly messages: Flow<unknown, FlowClose>
    /** Close the connection for good (never reconnected); resolves once fully closed. */
    close(code?: number, reason?: string): Operation<void>
    /** Resolves with the FINAL close code/reason once the connection permanently ends. */
    readonly closed: Future<CloseInfo>
  }

  /** The installed plugin context: install-time defaults, merged (shallow, per top-level key)
   * under each `connect` call's own options. */
  export interface Context {
    defaults: Options
  }

  export interface Actions {
    /** Open a WebSocket bound to the caller's scope. Resolves once the socket is OPEN, or raises
     * `'ws/connect'` (handshake error) / `'ws/unsupported'` (no impl — set `wsImpl`). */
    connect(url: string | URL, options?: Options): Operation<Connection>
  }
}

/** The shapes this module passes around inside itself. */
export namespace Helpers {
  /** Fully-resolved reconnect settings (absent entirely when reconnect is disabled). */
  export interface ReconnectBudget {
    retries: number
    delayMs: number
    backoff: number
    maxDelayMs: number
  }
}
