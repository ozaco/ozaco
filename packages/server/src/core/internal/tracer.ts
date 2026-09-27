import { useScope } from 'std:effect'
import { enableTracing, Tracer } from 'std:trace'

import pkg from '../../../package.json'
import type { ObserveDef } from '../types/observe'
import type { ServerDef } from '../types/server'

/** The resources `resourceOf` built, per kernel and service name. */
export const resources = new WeakMap<ServerDef.Context, Map<string, ObserveDef.Resource>>()

export const ServerTracerImpl = Tracer.implement<
  ServerDef.TracerContext,
  [kernel: ServerDef.Context]
>({
  name: 'server-tracer',
  version: pkg.version,
  description: 'std:trace → the kernel observe events (the store + every exporter)',

  /** Installed by createServer right after the kernel, BEFORE the carrier and the plugins, with
   * tracing OFF in the node's scope; createServer flips `state.enabled = kernel.observing` once
   * the plugins are in. */
  *setup(kernel) {
    // the node's OWN switch (a nested server never flips its parent's); createServer reads
    // whether tracing was already on here BEFORE this install and counts it as observing
    return { kernel, state: yield* enableTracing(false), scope: yield* useScope(), boot: [] }
  },
})
