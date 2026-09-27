import type { Operation, Scope } from 'std:effect'
import { attempt, ensure, sleep, useContext, useScope, within } from 'std:effect'
import { Logger } from 'std:logger'
import { fail } from 'std:result'
import type { AnyType } from 'std:shared'
import type { TraceDef } from 'std:trace'
import { registerFallback, suppressed, Tracer } from 'std:trace'

import { TraceTransport } from 'std:logger/transport/trace'

import { LocalCarrier } from '../definition/local'
import { MemoryOutcomes } from '../definition/outcomes'
import { ObserveExporter } from '../definition/protocol'
import { ServerClient } from '../definition/server'
import { ServerErrors } from '../errors'
import type { CarrierDef } from '../types/carrier'
import type { Helpers } from '../types/helpers'
import type { ServerDef } from '../types/server'
import type { ServiceDef } from '../types/service'
import { ServerTracer } from '../utils/trace'

import { awaitDependencies, healthOf, infoOf } from './app'
import { BOOT_RECORDS, DEFAULT_DRAIN_MS, DEFAULT_PAUSE_MS } from './const'
import { InheritedExporters } from './context'
import { markLoggedLines } from './forward'
import { apiOf, exporterEntries, installEntry, pluginOf, serverFor } from './kernel'
import { registerService, validateOptions } from './registry'

/** Hold a record for a node still coming up — until its `createServer` decides; nothing once it
 * decided (its tracing is off for good: a node that does not observe keeps its lines to itself). */
export const hold = (tracer: ServerDef.TracerContext, record: ServerDef.BootRecord): void => {
  if (tracer.boot && tracer.boot.length < BOOT_RECORDS) {
    tracer.boot.push(record)
  }
}

/**
 * A fallback record emitted inside ANOTHER node than `kernel` (its tracing off: coming up, or not
 * observing) is that node's — never `kernel`'s to claim: held for it while it comes up, dropped
 * otherwise. Whether it was handed over. Runs in the EMITTING scope (a fallback sink's rule).
 */
export function* handOver(kernel: ServerDef.Context, log: TraceDef.LogData): Operation<boolean> {
  const owner = yield* ServerTracer.context.get()

  if (!owner || owner.kernel === kernel) {
    return false
  }

  hold(owner, { log, own: true })
  return true
}

/**
 * The node's claim on the PROCESS's log records (`observe.processLogs`, on by default for an
 * observing node): a std:trace fallback sink that hands every record emitted where no Tracer
 * records to this node's Tracers — inside `scope` (the node's own contexts: its server-tracer, its
 * exporters and store), suppressed — so it becomes one observe event with the node's resource
 * (`service.name` = the node's, unless the record names a span service). `take()` queues the
 * claim (idempotent), `release()` gives it back (idempotent); a node that does not observe, or
 * opted out, claims nothing.
 */
export const processLogs = (
  kernel: ServerDef.Context,
  options: ServerDef.Options,
  scope: Scope,
): { readonly wanted: boolean; take(): void; release(): void } => {
  const wanted = kernel.observing && options.observe?.processLogs !== false
  let unregister: (() => void) | undefined

  const sink: TraceDef.FallbackSink = {
    id: kernel.serviceId,
    *emit(log) {
      if (yield* handOver(kernel, log)) {
        return
      }

      yield* within(scope, () => suppressed(() => Tracer.actions.emit(log)))
    },
  }

  return {
    wanted,
    take() {
      if (wanted && unregister === undefined) {
        unregister = registerFallback(sink)
      }
    },
    release() {
      unregister?.()
      unregister = undefined
    },
  }
}

/**
 * While a node comes up (its tracing still OFF, the plugins not in yet), what it logs — a carrier's
 * presence line, a store's first envelope — is HELD in its `boot` records instead of falling to
 * whichever node claims the process (it would carry THAT node's resource); so is the process's
 * own when no node claims it yet. `createServer` decides once the claim is taken
 * (`releaseBoot`): handed to the node's Tracers when it observes (the process's records only when
 * it claims them), dropped otherwise. Returns the unregister function.
 */
export const bootLogs = (
  kernel: ServerDef.Context,
  tracer: ServerDef.TracerContext,
): (() => void) =>
  registerFallback({
    id: `${kernel.serviceId}#boot`,
    *emit(log) {
      if (!(yield* handOver(kernel, log))) {
        hold(tracer, { log, own: (yield* ServerTracer.context.get()) !== undefined })
      }
    },
  })

/** The node decided: its held boot records go to its Tracers when it observes (the process's
 * ones only when it `claims` them); none are held from here on. */
export function* releaseBoot(
  kernel: ServerDef.Context,
  tracer: ServerDef.TracerContext,
  claims: boolean,
): Operation<void> {
  const held = tracer.boot ?? []
  tracer.boot = null

  if (!kernel.observing) {
    return
  }

  for (const { log, own } of held) {
    if (own || claims) {
      yield* attempt(() => suppressed(() => Tracer.actions.emit(log)))
    }
  }
}

/** `createServer` from the tracer on (its boot records held meanwhile). */
export function* buildNode<const TServices extends readonly ServiceDef.Service[]>(
  options: ServerDef.Options<TServices>,
  node: Helpers.NodeBuild,
): Operation<ServerDef.Handle<TServices>> {
  const { role, hosted, kernel, tracer, traced, unboot } = node

  // the carrier first: plugins may lean on it at setup (observe forward/collect, presence)
  if (options.carrier) {
    yield* installEntry(options.carrier)
    kernel.carrier = pluginOf(options.carrier) as CarrierDef
  } else {
    yield* LocalCarrier.use()
    kernel.carrier = LocalCarrier
  }

  // the node-level resource is complete before anything is recorded (`resourceOf` caches)
  kernel.telemetry.resource['ozaco.carrier.name'] = (yield* useContext(kernel.carrier)).transport

  // what exported BEFORE this node's plugins (an outer server's exporters) is not this node's:
  // its fan-out (export / start / flush) skips them
  const inherited = new Set(yield* exporterEntries())
  yield* InheritedExporters.set(inherited)

  for (const entry of options.plugins ?? []) {
    const context = (yield* installEntry(entry)) as ServerDef.PluginContext | undefined

    if (context?.hooks) {
      kernel.hooks.push(context.hooks)
    }

    // a plugin's own services (`PluginContext.services`) register like the app's — the one
    // sanctioned door into the registry
    for (const def of context?.services ?? []) {
      yield* registerService(kernel, def)
    }

    for (const [key, schema] of Object.entries(context?.options ?? {})) {
      if (kernel.options.has(key)) {
        return yield* fail(
          ServerErrors.Configuration,
          `action option "${key}" is claimed by two plugins`,
        )
      }

      kernel.options.set(key, schema)
    }
  }

  // exporters register through their own protocol (nested installs included) — one flag tells
  // the hot path whether fanning out is worth anything. Only THIS node's plugins count: a nested
  // server observes nothing through an outer server's exporters
  kernel.exporting = (yield* exporterEntries()).some(entry => !inherited.has(entry))
  kernel.observing = kernel.exporting || kernel.hooks.some(hooks => hooks.observe) || traced
  tracer.state.enabled = kernel.observing

  // the std Logger reaches the sinks too: its lines become log records of the active span
  // (`ctx.log` lines are emitted directly and marked, so they are never recorded twice). One
  // installed at the root already (the recommended setup — it also bridges the lines logged
  // OUTSIDE this node, to the process fallback) is what every line here resolves: no second one
  if (
    kernel.observing &&
    (yield* Logger.context.get()) !== undefined &&
    (yield* TraceTransport.context.get()) === undefined
  ) {
    yield* TraceTransport.use()
  }

  // the other way round: settled exceptions reach the Logger (the console) — except those a
  // Logger line produced (it printed them itself)
  if (kernel.observing) {
    yield* markLoggedLines()
  }

  if (!kernel.outcomes) {
    yield* MemoryOutcomes.use()
    kernel.outcomes = MemoryOutcomes
  }

  if (options.edge) {
    yield* installEntry(options.edge)
    kernel.edge = pluginOf(options.edge) as AnyType
  }

  yield* validateOptions(kernel)

  // the registry, not `options.services`: a plugin-registered service (observe) serves too
  for (const def of kernel.registry.services.values()) {
    if (kernel.hosted.has(def.name)) {
      yield* kernel.carrier.actions.serve(def.name, serverFor(kernel, def.name))
    }
  }

  // the process's untraced log records — claimed only now, once nothing above can fail (a node
  // that never came up must not swallow them); given back at `stop()` or when the scope ends
  const claim = processLogs(kernel, options as ServerDef.Options, yield* useScope())
  claim.take()
  yield* ensure(() => claim.release())

  // decided: what was held while coming up goes to this node's sinks (or nowhere) — the claim
  // takes over from here
  unboot()
  yield* releaseBoot(kernel, tracer, claim.wanted)

  const state: Helpers.NodeState = {
    role,
    hosted,
    options: options as ServerDef.Options,
    url: null,
    port: null,
    started: false,
    ready: false,
  }

  function* members(service: string): Operation<readonly CarrierDef.Member[]> {
    return yield* kernel.carrier!.actions.members(service)
  }

  return {
    api: apiOf(options.services),
    name: kernel.name,
    serviceId: kernel.serviceId,
    role,
    call: ServerClient.actions.call,
    emit: ServerClient.actions.emit,
    events: ServerClient.actions.events,
    manifest: ServerClient.actions.manifest,
    reload: ServerClient.actions.reload,
    members,

    *info() {
      return infoOf(state)
    },

    *health() {
      return yield* healthOf(state, kernel, members)
    },

    *start(listen) {
      const health = options.health ?? '/_health'

      // started again after a `stop()`: claim the process's log records again (queued behind
      // whoever took them meanwhile)
      claim.take()

      if (kernel.edge && health !== false) {
        yield* kernel.edge.actions.raw({
          method: 'GET',
          path: health,

          // probes (load balancers, orchestrators) carry no bearer — always public
          auth: false,

          // a probe every few seconds is noise: only a failing answer becomes a trace
          observe: 'errors',

          *handler() {
            const body = yield* healthOf(state, kernel, members)
            return Response.json(body, { status: body.ready ? 200 : 503 })
          },
        })
      }

      for (const hooks of kernel.hooks) {
        if (hooks.start) {
          yield* hooks.start()
        }
      }

      if (kernel.exporting) {
        yield* ObserveExporter.actions.start()
      }

      if (kernel.edge) {
        yield* kernel.edge.actions.mount()
        const info = yield* kernel.edge.actions.listen(listen ?? options.listen ?? {})
        state.url = info.url
        state.port = info.port
      }

      state.started = true
      yield* awaitDependencies(state, members)
      state.ready = true

      return infoOf(state)
    },

    *stop() {
      state.ready = false

      // 1. new requests get 503 while in-flight ones finish
      if (kernel.edge && state.started) {
        yield* attempt(() => kernel.edge!.actions.pause())
        yield* sleep(options.pauseMs ?? DEFAULT_PAUSE_MS)
      }

      // 2. leave the cluster: peers route around this node from here on
      yield* attempt(() => kernel.carrier!.actions.leave())

      // 3. close the front door
      if (kernel.edge) {
        yield* attempt(() => kernel.edge!.actions.stop())
      }

      // 4. let what is running finish (bounded), then stop serving
      const deadline = Date.now() + (options.drainMs ?? DEFAULT_DRAIN_MS)

      while (kernel.inflight > 0 && Date.now() < deadline) {
        yield* sleep(20)
      }

      for (const service of kernel.hosted) {
        yield* attempt(() => kernel.carrier!.actions.unserve(service))
      }

      // the process's log records go to the next observing node (if any) from here on: what was
      // logged while draining is still this node's, its plugins are about to stop
      claim.release()

      // 5. plugins, in reverse install order
      for (const hooks of kernel.hooks.toReversed()) {
        if (hooks.stop) {
          yield* attempt(hooks.stop)
        }
      }

      // 6. whatever the exporters still hold
      if (kernel.exporting) {
        yield* attempt(() => ObserveExporter.actions.flush())
      }

      state.started = false
      state.url = null
      state.port = null
    },
  }
}
