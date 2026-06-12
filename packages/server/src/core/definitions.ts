import { defineProtocol } from 'std:plugin'

import { BROKER, GATEWAY, POLICY, TRACER, TRANSPORT } from './const'
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
import type { GatewayDef } from './types/gateway'
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
  unknown[],
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

export const Tracer = defineProtocol<TracerDef.Context, unknown, unknown[], TracerDef.Actions>({
  name: 'server/tracer',
  version: '0.0.0',

  subtype: TRACER,
  cloneable: false,
})

export const Policy = defineProtocol<
  PolicyDef.Context,
  unknown,
  unknown[],
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

// The single web protocol. Server lifecycle + routing + REST/WS transformer signatures all live on
// `Gateway`, so a platform impl (BunGateway/NodeGateway) owns server/router/rest/ws internally and
// plugins hook one surface (cors: `Gateway.before({ fromInternal })`, docs: `Gateway.actions.mount`).
export const Gateway = defineProtocol<
  GatewayDef.Context,
  unknown,
  [options?: GatewayDef.Options],
  GatewayDef.Actions
>({
  name: 'server/gateway',
  version: '0.0.0',

  subtype: GATEWAY,
  cloneable: false,
})
