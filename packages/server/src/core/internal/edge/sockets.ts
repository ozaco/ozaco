// oxlint-disable import/exports-last
import { operation } from 'std:effect'

import { Broker } from '../../definition'
import type { Meta } from '../../types/common'
import type { Edge, SocketHandle } from '../../types/gateway'

/** Cross-replica room/broadcast relay event (string payloads only — bytes stay local). */
export const GW_FANOUT = '$gw.fanout'

export interface FanoutPayload {
  readonly gateway: string
  readonly op: 'room' | 'broadcast'
  readonly room?: string | undefined
  readonly data: string
}

interface Registered {
  readonly handle: SocketHandle
  readonly edge: Edge.Socket
  readonly rooms: Set<string>
}

export interface SocketRegistry {
  readonly handles: Map<string, Registered>
  readonly rooms: Map<string, Set<string>>
}

export const createSocketRegistry = (): SocketRegistry => ({
  handles: new Map(),
  rooms: new Map(),
})

export const deliverRoom = (
  registry: SocketRegistry,
  room: string,
  data: string | Uint8Array,
): void => {
  const members = registry.rooms.get(room)

  if (!members) {
    return
  }

  for (const id of members) {
    registry.handles.get(id)?.edge.send(data)
  }
}

export const deliverBroadcast = (registry: SocketRegistry, data: string | Uint8Array): void => {
  for (const entry of registry.handles.values()) {
    entry.edge.send(data)
  }
}

const detach = (registry: SocketRegistry, id: string): void => {
  const entry = registry.handles.get(id)

  if (!entry) {
    return
  }

  for (const room of entry.rooms) {
    const members = registry.rooms.get(room)

    members?.delete(id)

    if (members && members.size === 0) {
      registry.rooms.delete(room)
    }
  }

  registry.handles.delete(id)
}

export const removeSocket = (registry: SocketRegistry, id: string): void => detach(registry, id)

export interface HandleInput {
  readonly registry: SocketRegistry
  readonly gatewayId: string
  readonly edge: Edge.Socket
  readonly meta: Meta
  readonly params: Record<string, string>
}

/** Registers the connection and returns the engine-level handle a SocketRoute works with. */
export const registerSocket = (input: HandleInput): SocketHandle => {
  const { registry, gatewayId, edge, meta, params } = input
  const rooms = new Set<string>()

  const handle: SocketHandle = {
    id: edge.id,
    meta,
    params,
    send: data => edge.send(data),
    close: (code, reason) => edge.close(code, reason),
    join: room => {
      rooms.add(room)

      const members = registry.rooms.get(room) ?? new Set<string>()

      members.add(edge.id)
      registry.rooms.set(room, members)
    },
    leave: room => {
      rooms.delete(room)
      registry.rooms.get(room)?.delete(edge.id)
    },
    toRoom: operation(function* (room: string, data: string | Uint8Array) {
      deliverRoom(registry, room, data)

      if (typeof data === 'string') {
        const payload: FanoutPayload = { gateway: gatewayId, op: 'room', room, data }

        yield* Broker.actions.broadcast(GW_FANOUT, payload)
      }
    }),
    broadcast: operation(function* (data: string | Uint8Array) {
      deliverBroadcast(registry, data)

      if (typeof data === 'string') {
        const payload: FanoutPayload = { gateway: gatewayId, op: 'broadcast', data }

        yield* Broker.actions.broadcast(GW_FANOUT, payload)
      }
    }),
  }

  registry.handles.set(edge.id, { handle, edge, rooms })

  return handle
}

/** Applies a fanout event coming from ANOTHER gateway replica. */
export const applyFanout = (
  registry: SocketRegistry,
  gatewayId: string,
  payload: FanoutPayload,
): void => {
  if (payload.gateway === gatewayId) {
    return
  }

  if (payload.op === 'room' && payload.room) {
    deliverRoom(registry, payload.room, payload.data)

    return
  }

  if (payload.op === 'broadcast') {
    deliverBroadcast(registry, payload.data)
  }
}
