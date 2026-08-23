import type { AnyType } from 'std:shared'

export namespace DenoEdgeDef {
  /** The slice of the Deno namespace the edge uses — injectable so the suite runs under bun with
   * a fake, and so another runtime with the same shape can reuse the driver. */

  export interface Runtime {
    serve(
      options: {
        port?: number
        hostname?: string
        onListen?: (addr: { port: number; hostname: string }) => void
      },
      handler: (request: Request) => Response | Promise<Response>,
    ): { shutdown(): Promise<void>; addr: { port: number; hostname: string } }
    upgradeWebSocket(request: Request): { socket: WebSocket; response: Response }
  }

  export interface State {
    server: { shutdown(): Promise<void> } | null
    runtime: Runtime | AnyType
  }
}
