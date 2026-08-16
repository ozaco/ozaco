import { createContext } from 'std:effect'
import type { Context } from 'std:effect'

import type { BrokerContext } from '../types/broker'
import type { PolicyEntry } from '../types/policy'
import type { TransportDef } from '../types/transport'

/** The running broker — set scope-wide by `DefaultBroker.setup` so carriers and `invoke` reach it. */
export const BrokerRef: Context<BrokerContext> = createContext<BrokerContext>('server:core:broker')

export const TransportRegistryContext: Context<readonly TransportDef.Entry[]> = createContext<
  readonly TransportDef.Entry[]
>('server:core:transports', [])

export const PolicyRegistryContext: Context<readonly PolicyEntry[]> = createContext<
  readonly PolicyEntry[]
>('server:core:policies', [])
