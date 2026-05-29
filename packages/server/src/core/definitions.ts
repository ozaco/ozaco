import { defineProtocol } from 'std:plugin'

import { BROKER, CODEC, POLICY, TRACER, TRANSPORT } from './const'
import {
  codecDecode,
  codecDecodeStream,
  codecEncode,
  codecEncodeStream,
  codecGetTransportsHandler,
  codecRegisterHandler,
  codecUnregisterHandler,
} from './internal/codec-router'
import {
  policyDispatch,
  policyGetPoliciesHandler,
  policyRegisterHandler,
  policyUnregisterHandler,
} from './internal/policy-router'
import {
  transportBroadcast,
  transportDispatch,
  transportEmit,
  transportGetTransportsHandler,
  transportRegisterHandler,
  transportUnregisterHandler,
} from './internal/transport-router'
import type { BrokerDef } from './types/broker'
import type { CodecDef } from './types/codec'
import type { PolicyDef } from './types/policy'
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

    register: transportRegisterHandler,
    unregister: transportUnregisterHandler,
    getTransports: transportGetTransportsHandler,
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

    register: codecRegisterHandler,
    unregister: codecUnregisterHandler,
    getTransports: codecGetTransportsHandler,
  },
})

export const Policy = defineProtocol<
  PolicyDef.Context,
  unknown,
  [options?: PolicyDef.Options],
  PolicyDef.Actions,
  PolicyDef.Handlers
>({
  name: 'server/policy',
  version: '0.0.0',

  subtype: POLICY,
  cloneable: true,

  handlers: {
    dispatchRoot: policyDispatch,

    register: policyRegisterHandler,
    unregister: policyUnregisterHandler,
    getPolicies: policyGetPoliciesHandler,
  },
})
