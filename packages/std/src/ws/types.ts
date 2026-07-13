import type { Future, Operation, Stream } from 'std:effect'
import type { Result } from 'std:result'
import type { AnyType } from 'std:shared'

/**
 * `std:ws` — an effect-native WebSocket CLIENT, the socket counterpart to `std:fetch`. `connect()`
 * opens a socket (resolving once OPEN), then exposes incoming frames as an effect `Stream`, a `send`,
 * and a `closed` Future. Message framing mirrors the server gateway's WS handling and, like `std:fetch`,
 * runs through the registered `std:codec`: strings/binary go as-is, every other value is codec-encoded
 * on send + codec-decoded on receive. A codec (e.g. `JsonCodec`) must be installed in scope.
 */
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

  /** The WebSocket constructor `connect()` dispatches through (injectable via `wsImpl`). Accepts the
   * standard `protocols` second arg OR the Bun/Node options-object form (`{ headers, protocols }`). */
  export type Ctor = new (
    url: string | URL,
    options?:
      | string
      | string[]
      | { protocols?: string | string[]; headers?: Record<string, string> },
  ) => SocketLike

  export interface Options {
    /** Sub-protocol(s) offered on the handshake. */
    protocols?: string | string[]
    /** Handshake headers, e.g. `{ authorization: 'Bearer …' }`. Honored by Bun's and Node's global
     * `WebSocket` (passed as the options-object constructor form); the browser `WebSocket` cannot set
     * handshake headers — use a `?token=` query param there, matching the gateway's `wsBearer`. */
    headers?: Record<string, string>
  }

  /** The close value the message stream settles with: `true` on a clean close, or a failure on error. */
  export type StreamClose = true | Result.Failure<unknown>

  /** Why/how the socket closed. */
  export interface CloseInfo {
    code: number
    reason: string
  }

  /** Thrown faults pass through untouched (`unknown`); the only tags `connect` raises itself are
   * `'ws/unsupported'` (no WebSocket impl) and `'ws/connect'` (error before OPEN). */
  export type Error = unknown

  export interface Connection {
    /** The underlying platform socket (escape hatch). */
    readonly native: SocketLike
    readonly url: string
    /** Current `readyState` (0 CONNECTING · 1 OPEN · 2 CLOSING · 3 CLOSED). */
    readonly readyState: number
    /** Send a frame — strings/binary as-is, every other value encoded through the registered codec. */
    send(data: unknown): Operation<void>
    /** Incoming frames as an effect Stream (codec-decoded on pull); closes `true` on clean close or a
     * failure on error. */
    readonly messages: Stream<unknown, StreamClose>
    /** Close the socket; the returned op resolves once it is fully closed. */
    close(code?: number, reason?: string): Operation<void>
    /** Resolves with the close code/reason once the socket closes. */
    readonly closed: Future<CloseInfo>
  }
}
