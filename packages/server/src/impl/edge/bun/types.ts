import type { EdgeDef } from 'server:core'
import type { AnyType } from 'std:shared'

export namespace BunEdgeDef {
  export interface State {
    server: AnyType | null
  }

  /** The engine's raw socket over Bun's `ServerWebSocket`. */
  export interface SocketData {
    listeners: {
      message: ((data: string | Uint8Array) => void)[]
      close: ((code: number, reason: string) => void)[]
    }
    attach: ((socket: EdgeDef.RawSocket) => void) | null
  }
}
