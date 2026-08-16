import { defineProtocol } from 'std:plugin'
import type { AnyType, EmptyType } from 'std:shared'

import {
  AUTH_STRATEGY,
  BROKER,
  GATEWAY,
  GATEWAY_ADAPTER,
  METRICS_STORE,
  POLICY,
  TRACER,
  TRACE_EXPORTER,
  TRANSPORT,
} from '../const'
import type { AuthStrategyActions } from '../types/auth'
import type { BrokerActions, BrokerContext } from '../types/broker'
import type { GatewayActions, GatewayAdapterActions } from '../types/gateway'
import type { MetricsStoreActions } from '../types/metrics'
import type { PolicyHandlers } from '../types/policy'
import type { TraceExporterActions, TracerActions } from '../types/tracer'
import type { TransportActions, TransportDef } from '../types/transport'

import { noopDefaults, unsupportedDefaults } from './defaults'
import {
  policyDispatchRoot,
  policyGetHandler,
  policyRegisterHandler,
  policyUnregisterHandler,
} from './policy-router'
import {
  transportBroadcastRoot,
  transportDispatchRoot,
  transportEmitRoot,
  transportGetHandler,
  transportRegisterHandler,
  transportUnregisterHandler,
} from './transport-router'

/**
 * EVERY server protocol is defined here — including the ones whose implementations live in other
 * modules or later phases (gateway adapters, metrics stores, auth strategies, tracing). The
 * singletons in this file are the identity every impl builds against.
 */

/** The dispatch kernel. Implemented by `DefaultBroker` (`internal/broker.ts`). */
export const Broker = defineProtocol<BrokerContext, BrokerActions>({
  name: 'server/broker',
  version: '0.1.0',
  subtype: BROKER,
})

/**
 * The carrier seam. Implementations register themselves into the routing table; the broker only
 * ever talks to the `*Root` handlers. Impls: internal (core), worker + nats (`server:transport/*`).
 */
export const Transport = defineProtocol<AnyType, TransportActions, TransportDef.Handlers>({
  name: 'server/transport',
  version: '0.1.0',
  subtype: TRANSPORT,
  cloneable: true,
  handlers: {
    dispatchRoot: transportDispatchRoot,
    emitRoot: transportEmitRoot,
    broadcastRoot: transportBroadcastRoot,
    register: transportRegisterHandler,
    unregister: transportUnregisterHandler,
    getTransports: transportGetHandler,
  },
})

/** The resilience onion. Layers are created with `definePolicy`; impls in `server:policy/*`. */
export const Policy = defineProtocol<AnyType, EmptyType, PolicyHandlers>({
  name: 'server/policy',
  version: '0.1.0',
  subtype: POLICY,
  cloneable: true,
  handlers: {
    dispatchRoot: policyDispatchRoot,
    register: policyRegisterHandler,
    unregister: policyUnregisterHandler,
    getPolicies: policyGetHandler,
  },
})

/** The edge engine (implemented in core by `DefaultGateway`). */
export const Gateway = defineProtocol<AnyType, GatewayActions>({
  name: 'server/gateway',
  version: '0.1.0',
  subtype: GATEWAY,
  defaults: unsupportedDefaults<GatewayActions>('gateway', [
    'start',
    'stop',
    'isStarted',
    'pause',
    'resume',
    'mount',
    'unmount',
    'socket',
    'decorate',
    'preflight',
    'info',
  ]),
})

/** The per-runtime platform seam (impls: `server:gateway/{bun,node,deno}` at phase 1). */
export const GatewayAdapter = defineProtocol<AnyType, GatewayAdapterActions>({
  name: 'server/gateway-adapter',
  version: '0.1.0',
  subtype: GATEWAY_ADAPTER,
  defaults: unsupportedDefaults<GatewayAdapterActions>('gateway-adapter', ['serve']),
})

/** The analytics store seam (impls: `server:metrics/impl/{memory,starrocks}` at phase 5). */
export const MetricsStore = defineProtocol<AnyType, MetricsStoreActions>({
  name: 'server/metrics-store',
  version: '0.1.0',
  subtype: METRICS_STORE,
  cloneable: true,
  defaults: unsupportedDefaults<MetricsStoreActions>('metrics-store', [
    'init',
    'insert',
    'query',
    'sql',
    'define',
    'prune',
    'close',
  ]),
})

/** The auth strategy seam (impls: `server:auth` at phase 6). */
export const AuthStrategy = defineProtocol<AnyType, AuthStrategyActions>({
  name: 'server/auth-strategy',
  version: '0.1.0',
  subtype: AUTH_STRATEGY,
  cloneable: true,
  defaults: unsupportedDefaults<AuthStrategyActions>('auth-strategy', [
    'authorize',
    'hasRole',
    'hasPermission',
    'user',
    'signServiceToken',
    'authorizeSocket',
  ]),
})

/** OTel span factory (DefaultTracer in `server:trace` at phase 5). */
export const Tracer = defineProtocol<AnyType, TracerActions>({
  name: 'server/tracer',
  version: '0.1.0',
  subtype: TRACER,
  defaults: unsupportedDefaults<TracerActions>('tracer', [
    'startSpan',
    'parseTraceparent',
    'formatTraceparent',
  ]),
})

/** Span sink — no install means the zero-cost no-op path (OTLP impl in `server:trace`). */
export const TraceExporter = defineProtocol<AnyType, TraceExporterActions>({
  name: 'server/trace-exporter',
  version: '0.1.0',
  subtype: TRACE_EXPORTER,
  cloneable: true,
  defaults: noopDefaults<TraceExporterActions>(['export', 'flush']),
})
