import { defineProtocol } from 'std:plugin'

import { BROKER, TRACER, TRANSPORT } from './const'
import type { BrokerDef } from './types/broker'
import type { TracerDef } from './types/tracer'
import type { TransportDef } from './types/transport'

export const Broker = defineProtocol<BrokerDef.Context, unknown, unknown[], BrokerDef.Actions>({
  name: 'server/broker',
  version: '0.0.0',

  subtype: BROKER,
  cloneable: false,
})

export const Transport = defineProtocol<
  TransportDef.Context,
  unknown,
  [options?: TransportDef.Options],
  TransportDef.Actions
>({
  name: 'server/transport',
  version: '0.0.0',

  subtype: TRANSPORT,
  cloneable: true,
})

export const Tracer = defineProtocol<
  TracerDef.Context,
  unknown,
  [options?: TracerDef.Options],
  TracerDef.Actions
>({
  name: 'server/tracer',
  version: '0.0.0',

  subtype: TRACER,
  cloneable: false,
})
