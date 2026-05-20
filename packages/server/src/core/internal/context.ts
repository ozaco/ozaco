import { createContext } from 'std:effect'

import type { BrokerDef } from '../types/broker'
import type { TransportDef } from '../types/transport'

export const BrokerSettingContext = createContext<BrokerDef.Settings>(
  'server:core:broker-setting',
  {
    paused: false,
    started: false,
    destroying: false,
  },
)

export const TransportRegistryContext = createContext<TransportDef.Anyof[]>(
  'server:core:transport:registry',
  [],
)
