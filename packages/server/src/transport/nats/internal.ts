import type { TransportDef } from 'server:core'
import { useContext } from 'std:effect'

import { NatsTransport } from './definition'
import type { Nats } from './types'

export const getSelf = (): TransportDef => NatsTransport

export const useNatsContext = function* () {
  const ctx = yield* useContext(getSelf())
  return ctx as unknown as Nats.Context
}
