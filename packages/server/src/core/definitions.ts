import { defineProtocol } from 'std:plugin'

import { BROKER } from './const'
import type { BrokerDef } from './types/broker'

export const Broker = defineProtocol<BrokerDef.Context, unknown, unknown[], BrokerDef.Actions>({
  name: 'server/broker',
  version: '0.0.0',

  subtype: BROKER,
  cloneable: false,
})
