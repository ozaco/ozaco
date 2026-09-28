import type { Operation } from 'std:effect'
import { fail } from 'std:result'
import { Trace } from 'std:trace'

import { ServerClient } from '../definition/server'
import { ServerErrors } from '../errors'
import { hostedOf, roleOf } from '../internal/app'
import { bootLogs, buildNode } from '../internal/node'
import type { ServerDef } from '../types/server'
import type { ServiceDef } from '../types/service'

import { ServerTracer } from './trace'

/**
 * Build a node: install the kernel and its `server-tracer` (std:trace → the observe sinks,
 * switched OFF until the plugins are in), then the carrier (or the local one), every plugin (in
 * order), the outcome store (memory unless one is installed) and the edge — all std plugins —
 * wire their hooks and option validators into the kernel, validate every action's options, and
 * register the services this node hosts with the carrier. The node OBSERVES (tracing on) when a
 * plugin brought an `ObserveExporter` or an `observe` hook, or a non-server Trace sink was already
 * enabled around it; an installed std Logger then also gets a `TraceTransport` (its lines become
 * log records of the active span) — unless one is visible already.
 *
 * An observing node also claims the PROCESS's log records (`observe.processLogs`, default on):
 * lines logged where no Trace sink records — infrastructure (transport, db) installed BEFORE it, in a
 * parent scope — reach its store and exporters with its resource, through std:trace's process
 * fallback (`registerFallback`). One node per process takes them: the first one created; the next
 * takes over when it stops. Logger lines need a `TraceTransport` where they are LOGGED, so install
 * `DefaultLogger` + `ConsoleTransport` + `TraceTransport` at the ROOT (the node then skips its own
 * install, and every line becomes exactly one record: inside the node through its Trace sinks, outside
 * through the fallback). What a node logs while it comes up (tracing still off) is held for it
 * and never claimed by another node (`bootLogs`). Settled exception records at WARN or above also
 * reach the installed Logger (the console), once.
 *
 * The ROLE decides the shape: `monolith` (services + edge here), `gateway` (edge only, calls
 * forwarded over the carrier), `service` (hosted services, no edge unless one is given).
 * `start()` runs the plugins' start hooks, mounts `/_health`, listens and waits for
 * `dependsOn`; `stop()` pauses, leaves the cluster, drains and tears down in reverse.
 */
export function* createServer<const TServices extends readonly ServiceDef.Service[]>(
  options: ServerDef.Options<TServices>,
): Operation<ServerDef.Handle<TServices>> {
  const role = roleOf(options as ServerDef.Options)

  // an explicit empty `hosted` on a non-gateway is a silent trap: the node hosts nothing, then
  // (by the dependsOn default) waits for its OWN services and dies at start
  if (options.hosted !== undefined && options.hosted.length === 0 && role !== 'gateway') {
    return yield* fail(
      ServerErrors.Configuration,
      `hosted: [] hosts nothing — omit the field to host every declared service, or use role: 'gateway'`,
    )
  }

  if (role !== 'monolith' && !options.carrier) {
    return yield* fail(ServerErrors.Configuration, `role "${role}" needs a carrier`)
  }

  const hosted = hostedOf(options as ServerDef.Options, role)
  const kernel = yield* ServerClient.use({ ...options, hosted } as ServerDef.Options)

  // a Trace sink enabled around this server that is NOT another server's (a test's in-memory
  // tracer, an OTel bridge) means this node observes; an outer server's tracing does not — a
  // nested non-observing server keeps its spans to itself (its own disabled switch)
  const traced =
    (yield* Trace.actions.isTracing()) && (yield* ServerTracer.context.get()) === undefined

  // the tracer BEFORE the carrier and the plugins, switched OFF: every fork they make (serve
  // loops, presence, stores) shares the node's live switch, flipped once the plugins are in
  const tracer = yield* ServerTracer.use(kernel)

  // what is logged while the node comes up is held for it (`bootLogs`), never claimed by another
  const unboot = yield* bootLogs(kernel, tracer)

  try {
    return yield* buildNode(options, { role, hosted, kernel, tracer, traced, unboot })
  } finally {
    unboot()
  }
}
