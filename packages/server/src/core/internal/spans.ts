import type { Flow, Operation, Scope } from 'std:effect'
import { attempt, ensure } from 'std:effect'
import type { Result } from 'std:result'
import { asFailure, isFailure } from 'std:result'
import type { TraceDef } from 'std:trace'
import { Trace } from 'std:trace'

import { EXCEPTION_EVENT_NAME } from '../const'
import { ActiveRequest, RequestRef } from '../context'
import type { Helpers } from '../types/helpers'
import type { ServerDef } from '../types/server'
import type { ServiceDef } from '../types/service'
import type { StreamDef } from '../types/stream'
import type { WireDef } from '../types/wire'
import { statusOf, tagOf } from '../utils/failure'
import { brandOf, brandStream } from '../utils/stream'
import { scopeOf, wireParent } from '../utils/trace'

import { EVENT_RECV, RECV_LINKS } from './const'
import { DispatchScope } from './context'
import { noteFailure } from './forward'

/** The `creation` links each recording span added for its received items (weakly keyed). */
export const recvLinks = new WeakMap<TraceDef.SpanHandle, number>()

/** The recording SERVER dispatch span each failure it answered escaped (weakly keyed). */
export const answering = new WeakMap<Result.Failure<unknown>, TraceDef.SpanContext>()

/** How a dispatch span — or a plugin's span wrapping (part of) a dispatch — classifies a failure
 * escaping it: the action's `errors` map / the server table (`statusOf`), `tagOf`, and the
 * exception name of where it runs (`rpc.server.call.exception` over a carrier, else
 * `ozaco.action.exception`). */
export const dispatchFailureOf = (
  rpc: boolean,
  meta: Pick<ServiceDef.Meta, 'errors'> | null | undefined,
): TraceDef.FailureOptions => ({
  status: failure => statusOf(failure, meta ?? undefined),
  type: tagOf,
  eventName: rpc ? EXCEPTION_EVENT_NAME.rpcServer : EXCEPTION_EVENT_NAME.action,
})

/**
 * A dispatch's Flow output as it runs where it is materialized: every step under the dispatch's
 * contexts (`enter`), the dispatch span ended with the flow — drained (a Result failure it closes
 * with fails it), failed, or halted by its consumer (cancelled).
 */
export const dispatchFlow = (
  flow: Flow<unknown, unknown>,
  live: TraceDef.LiveSpan,
  enter: <R>(op: () => Operation<R>) => Operation<R>,
): Flow<unknown, unknown> => ({
  *[Symbol.iterator]() {
    let ended = false

    function* end(options: TraceDef.EndOptions = {}): Operation<void> {
      if (!ended) {
        ended = true
        yield* live.end(options)
      }
    }

    yield* ensure(() => (ended ? undefined : end({ cancelled: true })))

    const opened = yield* attempt(() => enter(() => flow))

    if (isFailure(opened)) {
      noteFailure(opened)
      yield* end({ failure: opened })

      return yield* opened
    }

    const inner = opened.value

    return {
      *next() {
        const step = yield* attempt(() => enter(() => inner.next()))

        if (isFailure(step)) {
          noteFailure(step)
          yield* end({ failure: step })

          return yield* step
        }

        if (step.value.done) {
          const closing: unknown = step.value.value

          if (isFailure(closing)) {
            noteFailure(closing)
          }

          yield* end(isFailure(closing) ? { failure: closing } : {})
        }

        return step.value
      },
    }
  },
})

/**
 * A platform stream a dispatch answered with, passed through so the dispatch span ends WITH it —
 * read to the end, errored (the error fails the span) or cancelled by its consumer. The span is
 * ended in `node` (the node's scope: the dispatch's own is long gone once a carrier pipes the
 * stream); a stream nobody ever reads leaves it open.
 */
export const endsWith = (
  source: StreamDef.Branded<string, unknown>,
  live: TraceDef.LiveSpan,
  node: Scope,
): StreamDef.Branded<string, unknown> => {
  const reader = source.getReader()
  let ended = false

  const end = (options: TraceDef.EndOptions): void => {
    if (ended) {
      return
    }

    ended = true

    if (options.failure) {
      noteFailure(options.failure)
    }

    try {
      void node.run(() => live.end(options), { detached: true })
    } catch {
      // the node is gone: nothing is exported any more
    }
  }

  const piped = new ReadableStream<unknown>({
    async pull(controller) {
      try {
        const step = await reader.read()

        if (step.done) {
          controller.close()
          end({})

          return
        }

        controller.enqueue(step.value)
      } catch (error) {
        controller.error(error)
        end({ failure: asFailure(error) })
      }
    },
    async cancel(reason) {
      end({ cancelled: true })
      await reader.cancel(reason)
    },
  })

  return brandStream(piped, brandOf(source as StreamDef.Branded))
}

/** Note that the recording SERVER dispatch span `context` answered `failure` over a carrier. */
export const noteAnswered = (
  failure: Result.Failure<unknown>,
  context: TraceDef.SpanContext,
): void => {
  answering.set(failure, context)
}

/**
 * The USER spans of a node — `ctx.span` / `Server.actions.span` (`root`: may also start a trace of
 * its own, classified like the server's own failures): under the active span, its
 * instrumentation scope the explicit `scope` (a name or `{ name, version }`), else the running
 * dispatch's ozaco service (`{ name: 'todos', version }`), else the node's (`{ name, version }`)
 * — never std's default.
 */
export const userSpanOf = (kernel: Pick<ServerDef.Context, 'name' | 'version'>, root = false) =>
  function* userSpan<T>(
    name: string,
    body: Helpers.SpanBody<T>,
    options: ServerDef.RootSpanOptions = {},
  ): Operation<T> {
    const explicit = typeof options.scope === 'string' ? { name: options.scope } : options.scope
    const scope = explicit ??
      (yield* DispatchScope.get()) ?? { name: kernel.name, version: kernel.version }

    return yield* Trace.actions.span(
      name,
      {
        kind: options.kind ?? 'internal',
        scope,
        attributes: options.attributes,
        links: options.links,
        ...(root
          ? { parent: options.parent, record: options.record, failure: classify('exception') }
          : {}),
      },
      body,
    )
  }

/**
 * Run `body` under a context that arrived from the wire: as a PASS-THROUGH when tracing is off
 * here (so a non-observing node still forwards it — `inject()` sends it on unchanged), untouched
 * otherwise (the span opened in `body` takes it as its parent).
 */
export function* withInbound<T>(
  parent: TraceDef.SpanContext | null | undefined,
  body: () => Operation<T>,
): Operation<T> {
  if (parent && !(yield* Trace.actions.isTracing())) {
    return yield* Trace.actions.passThrough(parent, body)
  }

  return yield* body()
}

/** Events named `_…` are the kernel's / plugins' own plumbing (the observe cluster): never
 * traced, published transient, hidden from `Server.actions.events()`. */
export const isInternalEvent = (name: string): boolean => name.startsWith('_')

/** How a kernel span that is not a dispatch classifies an escaping failure: the server's status
 * table (`statusOf`: a validation failure is a 400, an unmapped tag a 500) and `tagOf`. */
export const classify = (eventName: string): TraceDef.FailureOptions => ({
  status: failure => statusOf(failure),
  type: tagOf,
  eventName,
})

export const messaging = (
  name: string,
  operation: 'send' | 'process',
): TraceDef.AttributesInput => ({
  'messaging.system': 'ozaco',
  'messaging.operation.type': operation,
  'messaging.operation.name': operation === 'send' ? 'publish' : 'process',
  'messaging.destination.name': name,
})

/** `emit` (§6.2): the PRODUCER span `publish {event}` of the envelope `id`
 * (`messaging.message.id`) — `body` injects the wire trace inside it (`wireTrace`), so every
 * consumer links back here. */
export const publishSpan = <T>(name: string, id: string, body: Helpers.SpanBody<T>): Operation<T> =>
  Trace.actions.span(
    `publish ${name}`,
    {
      kind: 'producer',
      scope: scopeOf(),
      attributes: { ...messaging(name, 'send'), 'messaging.message.id': id },
      failure: classify(EXCEPTION_EVENT_NAME.send),
    },
    body,
  )

/**
 * Handle one event (`Server.actions.process`, §6.2): the CONSUMER span `process {event}` —
 * parented to the ambient span when there is one, else to the emitter's PRODUCER span (a local
 * root continuing its trace; a new trace when the envelope carried none) — ALWAYS linking the
 * producer (`ozaco.link.reason = 'creation'`). Outside any request the emitter's request id
 * becomes the running one (`RequestRef`), so calls made while handling it stay correlated.
 */
export function* processSpan<T>(
  item: ServerDef.EventItem,
  body: Helpers.SpanBody<T>,
): Operation<T> {
  const ambient = yield* Trace.actions.activeContext()
  const creation = item.trace ?? null

  const options: TraceDef.SpanOptions = {
    kind: 'consumer',
    scope: scopeOf(),
    attributes: { ...messaging(item.name, 'process'), 'messaging.message.id': item.id },
    links: creation ? [{ context: creation, attributes: { 'ozaco.link.reason': 'creation' } }] : [],
    failure: classify(EXCEPTION_EVENT_NAME.process),
    ...(ambient ? {} : { parent: creation }),
  }

  // no ambient span: the producer's context is what the handler's own calls continue — carried
  // as a pass-through where tracing is off, so a non-observing consumer still forwards it
  const run = (): Operation<T> =>
    ambient
      ? Trace.actions.span(`process ${item.name}`, options, body)
      : withInbound(creation, () => Trace.actions.span(`process ${item.name}`, options, body))

  if ((yield* RequestRef.get()) !== undefined) {
    return yield* run()
  }

  const requestId = item.requestId || (yield* Trace.actions.newTraceId())

  return yield* RequestRef.with(new ActiveRequest(requestId, 'internal'), run)
}

/** The event item a wire envelope becomes — its producer context (`trace`) and request id; the
 * ambient recording span (if any) gets an `event.recv` span event (the destination and
 * `messaging.message.id`) and — its first {@link RECV_LINKS} items — a LINK to the item's
 * creation context (`ozaco.link.reason = 'creation'`, as a consumer span links it). */
export function* eventItemOf(event: WireDef.Event): Operation<ServerDef.EventItem> {
  const handle = yield* Trace.actions.current()
  const trace = yield* wireParent(event.trace)

  if (handle.recording) {
    handle.addEvent(EVENT_RECV, {
      'messaging.destination.name': event.name,
      'messaging.message.id': event.id,
    })

    const linked = recvLinks.get(handle) ?? 0

    if (trace && linked < RECV_LINKS) {
      recvLinks.set(handle, linked + 1)
      handle.addLink(trace, { 'ozaco.link.reason': 'creation', 'messaging.message.id': event.id })
    }
  }

  return {
    ...(event.id ? { id: event.id } : {}),
    name: event.name,
    payload: event.payload,
    origin: event.origin,
    trace,
    requestId: event.trace?.request_id ?? '',
  }
}
