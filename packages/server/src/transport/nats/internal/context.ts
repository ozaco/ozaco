import { createContext } from 'std:effect'
import type { Context } from 'std:effect'

import type { Nats } from '../types'

/**
 * The running transport instance — set scope-wide by `NatsTransport.setup` (its own context key,
 * so later installs of OTHER Transport impls can never shadow it, mirroring the broker's
 * `BrokerRef`).
 */
export const NatsRef: Context<Nats.Context> = createContext<Nats.Context>(
  'server:transport/nats:state',
)
