import type { AnyType } from 'std:shared'

import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'

import type { WebSocket, WebSocketServer } from 'ws'

/** The raw Node upgrade triple emitted by `http.Server`'s `upgrade` event. */
export interface WsUpgrade {
  req: IncomingMessage
  socket: Duplex
  head: Buffer
}

/** Platform-agnostic hooks the gateway funnels the raw `ws` connection events into. */
export interface WsBinding {
  data: unknown
  onOpen: (ws: WebSocket) => void
  onMessage: (ws: WebSocket, message: unknown) => void
  onClose: (ws: WebSocket, code: number, reason: string) => void
}

// Lazily construct a `ws` WebSocketServer. `ws` is an OPTIONAL peer dep (Node has no built-in WS
// server), so the dynamic import stays lazy and returns undefined when it isn't installed — letting
// the gateway start without WebSocket support instead of crashing. The impure boundary to the `ws`
// library lives HERE (external/), never in the gateway orchestration.
export const createWsServer = async (): Promise<WebSocketServer | undefined> => {
  try {
    const mod = await import('ws')
    return new mod.WebSocketServer({ noServer: true })
  } catch {
    return undefined
  }
}

// Complete the WS handshake on a raw upgrade, stamp `binding.data` onto the socket synchronously (so
// it is set before the first inbound frame), and funnel the raw `ws` events into the binding's
// callbacks — binary frames pass through untouched, text is decoded to a string.
export const upgradeWs = (wss: WebSocketServer, upgrade: WsUpgrade, binding: WsBinding): void => {
  wss.handleUpgrade(upgrade.req, upgrade.socket, upgrade.head, nodeWs => {
    ;(nodeWs as AnyType).data = binding.data
    binding.onOpen(nodeWs)
    nodeWs.on('message', (raw: AnyType, isBinary: boolean) => {
      binding.onMessage(nodeWs, isBinary ? (raw as unknown) : String(raw))
    })
    nodeWs.on('close', (code: number, reason: AnyType) => {
      binding.onClose(nodeWs, code, String(reason ?? ''))
    })
  })
}
