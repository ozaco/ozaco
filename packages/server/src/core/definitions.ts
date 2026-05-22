import { defineProtocol } from 'std:plugin'

import { BROKER, CODEC, TRACER, TRANSPORT } from './const'
import {
  codecDecode,
  codecDecodeStream,
  codecEncode,
  codecEncodeStream,
} from './internal/codec-router'
import { transportBroadcast, transportDispatch, transportEmit } from './internal/transport-router'
import type { BrokerDef } from './types/broker'
import type { CodecDef } from './types/codec'
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
  TransportDef.Actions,
  TransportDef.Handlers
>({
  name: 'server/transport',
  version: '0.0.0',

  subtype: TRANSPORT,
  cloneable: true,

  handlers: {
    dispatchRoot: transportDispatch,
    emitRoot: transportEmit,
    broadcastRoot: transportBroadcast,
  },
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

export const Codec = defineProtocol<
  CodecDef.Context,
  unknown,
  [options?: CodecDef.Options],
  CodecDef.Actions,
  CodecDef.Handlers
>({
  name: 'server/codec',
  version: '0.0.0',

  subtype: CODEC,
  cloneable: true,

  handlers: {
    encodeRoot: codecEncode,
    decodeRoot: codecDecode,
    encodeStreamRoot: codecEncodeStream,
    decodeStreamRoot: codecDecodeStream,
  },
})
