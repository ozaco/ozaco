import { createContext, operation } from 'std:effect'

import type { BrokerDef } from '../types/broker'
import type { PolicyDef } from '../types/policy'
import type { TransportDef } from '../types/transport'

export const BrokerSettingContext = createContext<BrokerDef.Settings>(
  'server:core:broker-setting',
  {
    paused: false,
    started: false,
    destroying: false,
  },
)

/** Merge a partial into the current broker settings — collapses the `set({ ...(yield* get())!, x })`
 * read-modify-write the broker lifecycle actions would otherwise repeat. */
export const patchSetting = operation(function* (partial: Partial<BrokerDef.Settings>) {
  yield* BrokerSettingContext.set({ ...(yield* BrokerSettingContext.get())!, ...partial })
})

export const TransportRegistryContext = createContext<TransportDef[]>(
  'server:core:transport:registry',
  [],
)

export const PolicyRegistryContext = createContext<PolicyDef[]>('server:core:policy:registry', [])
