import { createContext } from 'std:effect'

import type { BrokerDef } from '../types/broker'
import type { CodecDef } from '../types/codec'
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

export const TransportRegistryContext = createContext<TransportDef[]>(
  'server:core:transport:registry',
  [],
)

export const CodecRegistryContext = createContext<CodecDef[]>('server:core:codec:registry', [])

export const PolicyRegistryContext = createContext<PolicyDef[]>('server:core:policy:registry', [])
