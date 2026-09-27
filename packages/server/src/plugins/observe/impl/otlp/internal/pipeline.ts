import type { ObserveDef, ServerDef } from 'server:core'
import { resourceOf } from 'server:internal'

import type { Helpers } from '../types/helpers'
import type { OtlpDef } from '../types/otlp'

import { RETRY_DEFAULTS } from './const'

export const SIGNALS: Readonly<Record<Helpers.SignalKey, OtlpDef.Signal>> = {
  spans: 'traces',
  logs: 'logs',
  metrics: 'metrics',
}

export const counters = (): OtlpDef.SignalStats => ({
  sent: 0,
  dropped: 0,
  failed: 0,
  rejected: 0,
  retried: 0,
  lastError: null,
})

export const retryOf = (retry: OtlpDef.Options['retry']): Helpers.RetryPolicy =>
  retry === false
    ? { attempts: 1, initialMs: 0, maxMs: 0 }
    : {
        attempts: Math.max(1, Math.floor(retry?.attempts ?? RETRY_DEFAULTS.attempts)),
        initialMs: retry?.initialMs ?? RETRY_DEFAULTS.initialMs,
        maxMs: retry?.maxMs ?? RETRY_DEFAULTS.maxMs,
      }

/** The resources whose `ozaco.service.up` reads 1: every service this node serves (the node's
 * own resource when it serves none — a gateway). */
export const upResources = (kernel: ServerDef.Context): ObserveDef.Resource[] =>
  kernel.hosted.size > 0
    ? [...kernel.hosted].map(service => resourceOf(kernel, service))
    : [resourceOf(kernel, null)]
