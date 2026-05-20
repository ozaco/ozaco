import { createContext } from 'std:effect'

import type { BrokerDef } from '../types/broker'

export const BrokerSettingContext = createContext<BrokerDef.Settings>(
  'server:core:broker-setting',
  {
    paused: false,
    started: false,
    destroying: false,
  },
)
