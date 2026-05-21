import type { TransportDef } from 'server:core'
import { Broker } from 'server:core'
import { operation, useContext } from 'std:effect'

import type { Msg } from 'nats'

import { decodeMessage } from './wire'

export const handleEmit = operation(function* (msg: Msg) {
  const decoded = (yield* decodeMessage(msg.data)) as TransportDef.EventRequest
  const broker = yield* useContext(Broker)

  broker.bus.emit('event.emit', decoded)
})

export const handleBroadcast = operation(function* (msg: Msg) {
  const decoded = (yield* decodeMessage(msg.data)) as TransportDef.EventRequest
  const broker = yield* useContext(Broker)

  broker.bus.emit('event.broadcast', decoded)
})
