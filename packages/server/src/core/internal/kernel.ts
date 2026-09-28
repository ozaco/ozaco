// oxlint-disable import/exports-last
import type { Flow, Operation } from 'std:effect'
import { attempt, ensure, useContext } from 'std:effect'
import type { Plugin, Protocol } from 'std:plugin'
import { isUse } from 'std:plugin'
import { fail, isFailure } from 'std:result'
import type { AnyType } from 'std:shared'
import type { TraceDef } from 'std:trace'
import { Trace } from 'std:trace'

import { ActiveRequest, RequestRef } from '../context'
import { ObserveExporter, Server } from '../definition/protocol'
import { ServerErrors } from '../errors'
import type { CarrierDef } from '../types/carrier'
import type { Helpers } from '../types/helpers'
import type { OutcomesDef } from '../types/outcomes'
import type { ServerDef } from '../types/server'
import type { ServiceDef } from '../types/service'
import type { StreamDef } from '../types/stream'
import type { WireDef } from '../types/wire'
import { statusOf } from '../utils/failure'
import { isSocketAction, ref } from '../utils/service'
import { brandOf, brandStream, isBranded, stream } from '../utils/stream'
import { carrierSpan, isRequestId, wireParent, wireTrace, withDispatchSpan } from '../utils/trace'

import { ExporterProbe } from './context'
import { materialize, runDispatch } from './dispatch'
import { actionKey } from './registry'
import { withInbound } from './spans'
import { isDeferred } from './stream'

/** The transport name of the same-process `LocalCarrier`: a hop over it never leaves this node. */
const IN_PROCESS = 'local'

/** A header name (an RFC 9110 token) and value (no CR / LF / NUL) `Headers` accepts. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u
const HEADER_VALUE = /^[^\0\r\n]*$/u

/**
 * A reply's `http` (the owner's `ctx.reply`) as this node's edge may apply it: an integer status
 * a `Response` takes (200–599) and the well-formed string headers — another node's word is data,
 * never trusted to be well-formed. `null` when nothing usable is left.
 */
const httpOf = (http: WireDef.HttpReply | undefined): ServerDef.Reply | null => {
  if (!http || typeof http !== 'object') {
    return null
  }

  const { status } = http
  const usable = typeof status === 'number' && Number.isInteger(status) && status >= 200
  const headers = Object.entries(
    http.headers && typeof http.headers === 'object' ? http.headers : {},
  ).filter(
    ([name, value]) =>
      typeof value === 'string' && HEADER_NAME.test(name) && HEADER_VALUE.test(value),
  )

  if ((!usable || status > 599) && headers.length === 0) {
    return null
  }

  return {
    ...(usable && status <= 599 ? { status } : {}),
    ...(headers.length > 0 ? { headers: Object.fromEntries(headers) } : {}),
  }
}

/** Hand the owner's `ctx.reply` (the reply's usable `http`) to the edge that forwarded the call
 * (`remote.reply`: a gateway); what was handed, or `null`. */
const forwardReply = (
  sent: CarrierDef.Sent,
  remote: Helpers.RemoteCall,
): ServerDef.Reply | null => {
  const http = httpOf(sent.reply.http)

  if (http) {
    remote.reply?.(http)
  }

  return http
}

/** What a reply resolves to for the caller: its value, or its first output lane attached in THIS
 * scope — the owner's `ctx.reply` forwarded first (`forwardReply`). */
function* replyOf(sent: CarrierDef.Sent, remote: Helpers.RemoteCall): Operation<unknown> {
  forwardReply(sent, remote)

  const [output] = sent.reply.outputs

  if (output) {
    return yield* sent.lane(output.name)
  }

  return sent.reply.value
}

/**
 * A streamed reply that ends the carrier CLIENT span with the stream: once it is drained, with
 * its failure, or cancelled when the consumer lets go of it (the pump halts — also when the
 * consuming scope closes before reading).
 */
function* tracedLane(
  source: StreamDef.Branded,
  live: TraceDef.LiveSpan,
): Operation<StreamDef.Branded> {
  const flow: Flow<unknown, void> = {
    *[Symbol.iterator]() {
      const inner = yield* stream.flow(source as StreamDef.Branded<string, unknown>)
      let ended = false

      yield* ensure(() => (ended ? undefined : live.end({ cancelled: true })))

      return {
        *next() {
          const step = yield* attempt(() => inner.next())

          if (isFailure(step)) {
            ended = true
            yield* live.end({ failure: step })

            return yield* step
          }

          if (step.value.done) {
            ended = true
            yield* live.end()
          }

          return step.value
        },
      }
    },
  }

  return (yield* stream.of(flow, brandOf(source))) as StreamDef.Branded
}

/**
 * Send a call over the carrier: input lanes from the input's shape, the wire trace injected, the
 * reply's value — or its first output lane attached in THIS scope. Over a network carrier the
 * hop is a CLIENT span `{service}.{action}` (`rpc.*`, `rpc.response.status_code`) that covers a
 * streamed reply until its lane closes; the owner's failure comes back as it was raised there
 * (already recorded by the owner: only status / `error.type` here). Over the same-process
 * `LocalCarrier` there is no hop to trace: the callee's dispatch runs INTERNAL under the active
 * span (no CLIENT/SERVER self-loop in the service graph). The owner's `ctx.reply` (status,
 * `Location`, …) rides the reply back to `remote.reply` — the edge that forwarded the call.
 */
export function* callRemote(
  kernel: ServerDef.Context,
  remote: Helpers.RemoteCall,
): Operation<unknown> {
  const carrier = yield* carrierOf(kernel)
  const meta = kernel.registry.actions.get(actionKey(remote.service, remote.action))?.meta
  const { args, inputs } = lanesOf(remote.input, meta?.inputPlane)

  // the wire trace is taken INSIDE the CLIENT span: the owner's SERVER span is its child
  const send = function* (): Operation<CarrierDef.Sent> {
    const dispatch: WireDef.Dispatch = {
      k: 'dispatch',
      cid: remote.cid,
      service: remote.service,
      action: remote.action,
      args,
      trace: yield* wireTrace(remote.requestId),
      inputs: inputs.map(lane => ({ name: lane.name, brand: lane.brand })),
      deadline: remote.deadline,
      idempotencyKey: remote.idempotencyKey,
      meta: remote.meta,
    }

    return yield* carrier.actions.send(dispatch, inputs)
  }

  if ((yield* useContext(carrier)).transport === IN_PROCESS) {
    return yield* replyOf(yield* send(), remote)
  }

  const live = yield* carrierSpan({ service: remote.service, action: remote.action, meta })

  // a caller halted mid-hop (a lost race, a disconnect, its own deadline) still ENDS the span —
  // cancelled — unless a streamed reply took it over (`end` is idempotent)
  let handedOver = false

  try {
    const outcome = yield* attempt(() =>
      live.run(function* () {
        const sent = yield* send()
        const status = forwardReply(sent, remote)?.status
        const [output] = sent.reply.outputs

        return output
          ? { status, lane: yield* sent.lane(output.name) }
          : { status, lane: null, value: sent.reply.value }
      }),
    )

    if (isFailure(outcome)) {
      live.setAttribute('rpc.response.status_code', String(statusOf(outcome, meta)))
      yield* live.end({ failure: outcome })

      return yield* outcome
    }

    // the status the reply stands for: the owner's `ctx.reply`, else the declared one
    live.setAttribute(
      'rpc.response.status_code',
      String(outcome.value.status ?? meta?.status ?? 200),
    )

    if (outcome.value.lane) {
      const lane = yield* tracedLane(outcome.value.lane, live)

      handedOver = true

      return lane
    }

    yield* live.end()

    return outcome.value.value
  } finally {
    if (!handedOver) {
      yield* live.end({ cancelled: true })
    }
  }
}

export function* carrierOf(kernel: ServerDef.Context): Operation<CarrierDef> {
  if (!kernel.carrier) {
    return yield* fail(ServerErrors.Configuration, 'the server has no carrier yet (createServer)')
  }

  return kernel.carrier
}

/** Input streams a caller hands over: the value plane travels in `args`, streams as lanes.
 * When the callee's DECLARED plane is known (the registry has its meta), the declaration
 * decides; otherwise the value's shape does (a caller need not know a foreign declaration). */
const lanesOf = (
  input: unknown,
  plane?: ServiceDef.Meta['inputPlane'],
): { args: unknown; inputs: CarrierDef.InputLane[] } => {
  if (plane === 'none' || plane === 'value') {
    return { args: input, inputs: [] }
  }

  if (isBranded(input)) {
    return { args: undefined, inputs: [{ name: 'body', brand: brandOf(input), source: input }] }
  }

  if (input && typeof input === 'object' && 'streams' in input && 'fields' in input) {
    const parts = input as StreamDef.Parts<unknown, string>
    const streams = Object.entries(parts.streams).filter(([, source]) => isBranded(source))

    if (streams.length > 0) {
      return {
        args: parts.fields,
        inputs: streams.map(([name, source]) => ({ name, brand: brandOf(source), source })),
      }
    }
  }

  return { args: input, inputs: [] }
}

function* outcomeOf(kernel: ServerDef.Context, outcome: OutcomesDef.Outcome): Operation<void> {
  if (kernel.outcomes) {
    yield* attempt(() => kernel.outcomes!.actions.put(outcome))
  }
}

/** Run `body` as a request of its own (a call from outside any dispatch, `origin: internal`):
 * `RequestRef` is set, so every call it makes belongs to it. No span of its own — the dispatch
 * (or carrier CLIENT) span it opens is the trace's root when nothing is active. */
export function* asRequest<T>({ request, body }: Helpers.RootCall<T>): Operation<T> {
  const active =
    request instanceof ActiveRequest
      ? request
      : new ActiveRequest(request.requestId, request.origin)

  return yield* RequestRef.with(active, body)
}

/** The kernel's own actions as the dispatch pipeline needs them (bound, no dispatch cost). */
export const actionsOf = (kernel: ServerDef.Context) => ({
  call: Server.actions.call,
  emit: Server.actions.emit,
  outcome: (outcome: OutcomesDef.Outcome) => outcomeOf(kernel, outcome),
})

/** Every `ObserveExporter` install the current scope's fan-out reaches (none is run). */
export function* exporterEntries(): Operation<readonly Protocol.Install[]> {
  const found: Protocol.Install[] = []

  yield* ExporterProbe.with(found, () => ObserveExporter.actions.flush())

  return found
}

/** Install a plugin entry (`Plugin.use(...args)`, or a bare handle); resolves its
 * context. */
export function* installEntry(entry: ServerDef.PluginLike): Operation<unknown> {
  if (isUse(entry)) {
    return yield* entry
  }

  return yield* (entry as Plugin<AnyType, [], AnyType>).use()
}

/**
 * The serving side of one service: what the carrier calls for a dispatch arriving here. The
 * definition is looked up on EVERY dispatch, so a `reload` reaches carrier traffic too. Over a
 * network carrier the dispatch CONTINUES the caller's trace (`dispatch.trace`, sampled flag
 * honoured; a pass-through when tracing is off here) in a SERVER span; over the same-process
 * `LocalCarrier` it runs INTERNAL under the active span. The request id travels on the wire.
 */
export const serverFor = (kernel: ServerDef.Context, name: string): CarrierDef.Server =>
  function* (dispatch, inputs) {
    const transport = kernel.carrier ? (yield* useContext(kernel.carrier)).transport : IN_PROCESS
    const inProcess = transport === IN_PROCESS
    const request = inProcess ? yield* RequestRef.get() : undefined
    const wired = dispatch.trace?.request_id
    const requestId = isRequestId(wired)
      ? wired
      : (request?.requestId ?? (yield* Trace.actions.newTraceId()))
    const controller = new AbortController()

    // the handler's `ctx.reply`, merged like the edge merges it: carried back as the reply's
    // `http` for the edge that forwarded the call (a gateway)
    let http: WireDef.HttpReply | undefined
    const served = (value: unknown, outputs: CarrierDef.OutputLane[]): CarrierDef.Served =>
      http ? { value, outputs, http } : { value, outputs }

    const call: ServerDef.Call = {
      cid: dispatch.cid,
      service: name,
      action: dispatch.action,
      input: dispatch.args,
      requestId,
      origin: request?.origin ?? 'external',
      ...(inProcess ? {} : { parent: yield* wireParent(dispatch.trace) }),
      headers: dispatch.meta ?? {},
      deadline: dispatch.deadline,
      idempotencyKey: dispatch.idempotencyKey,
      transport,
      signal: controller.signal,
      abort: reason => controller.abort(reason),
      reply: reply => {
        http = {
          status: reply.status ?? http?.status,
          headers: { ...http?.headers, ...reply.headers },
        }
      },
    }

    const service = kernel.registry.services.get(name)
    const def = service?.actions[dispatch.action]

    if (!service || !def || isSocketAction(def)) {
      // an unknown action still answers inside its span (named `ozaco`, `rpc.method` `_OTHER`)
      return yield* withInbound(call.parent, () =>
        withDispatchSpan(
          { kernel, call, meta: null, kind: inProcess ? 'internal' : 'server' },
          function* () {
            return yield* fail(ServerErrors.NotFound, `no action "${name}.${dispatch.action}"`)
          },
        ),
      )
    }

    // rebuild the input from the value plane + announced lanes
    let input: unknown = dispatch.args

    if (def.meta.inputPlane === 'stream') {
      const [lane] = dispatch.inputs

      input = lane ? yield* inputs(lane.name) : undefined
    } else if (def.meta.inputPlane === 'parts') {
      const streams: Record<string, StreamDef.Branded> = {}

      for (const lane of dispatch.inputs) {
        streams[lane.name] = brandStream(yield* inputs(lane.name), lane.brand)
      }

      input = { fields: dispatch.args, streams }
    }

    yield* ensure(() => {
      if (!controller.signal.aborted) {
        controller.abort(ServerErrors.Cancelled)
      }
    })

    const outcome = yield* runDispatch(kernel, { ...call, input }, { actions: actionsOf(kernel) })

    if (isFailure(outcome)) {
      return yield* outcome
    }

    const { value } = outcome

    if (isDeferred(value)) {
      // materialized by the consumer (local caller / carrier pipe job) in its own scope
      return served(undefined, [
        { name: 'body', brand: value.brand, open: () => materialize(value) as AnyType },
      ])
    }

    if (isBranded(value)) {
      return served(undefined, [
        {
          name: 'body',
          brand: brandOf(value),
          *open() {
            return value
          },
        },
      ])
    }

    return served(value, [])
  }

/** `server.api`: typed refs for every declared action. */
export const apiOf = <TServices extends readonly ServiceDef.Service[]>(
  services: TServices,
): ServiceDef.Api<TServices> =>
  Object.fromEntries(
    services.map(def => [
      def.name,

      Object.fromEntries(
        Object.entries(def.actions)
          .filter(([, entry]) => !isSocketAction(entry))
          .map(([name]) => [name, ref(def.name, name)]),
      ),
    ]),
  ) as AnyType

export const pluginOf = (entry: ServerDef.PluginLike): Plugin<AnyType, AnyType[], AnyType> =>
  isUse(entry) ? entry.plugin : (entry as AnyType)
