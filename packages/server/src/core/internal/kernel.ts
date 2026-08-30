// oxlint-disable import/exports-last
import type { Operation } from 'std:effect'
import { attempt, ensure, useContext } from 'std:effect'
import type { Plugin } from 'std:plugin'
import { install, isUse } from 'std:plugin'
import { fail, isFailure } from 'std:result'
import type { AnyType } from 'std:shared'

import { laneOf } from '../const'
import { TraceRef } from '../context'
import { Server } from '../definition/protocol'
import { ServerErrors } from '../errors'
import type { CarrierDef } from '../types/carrier'
import type { Helpers } from '../types/helpers'
import type { ServerDef } from '../types/server'
import type { ServiceDef } from '../types/service'
import type { StreamDef } from '../types/stream'
import type { TraceDef } from '../types/trace'
import type { WireDef } from '../types/wire'
import { statusOf } from '../utils/failure'
import { isSocketAction, ref } from '../utils/service'
import { brandOf, brandStream, isBranded } from '../utils/stream'
import { childTrace, continueTrace, report, rootTrace, toWire, withSpan } from '../utils/trace'

import { isDeferred, materialize, runDispatch } from './dispatch'
import { actionKey } from './registry'

/** Send a call over the carrier (a `carrier` span): input lanes from the input's shape, the
 * reply's value — or its first output lane attached in THIS scope. */
export function* callRemote(
  kernel: ServerDef.Context,
  remote: Helpers.RemoteCall,
): Operation<unknown> {
  const carrier = yield* carrierOf(kernel)
  const meta = kernel.registry.actions.get(actionKey(remote.service, remote.action))?.meta
  const { args, inputs } = lanesOf(remote.input, meta?.inputPlane)
  const cid = remote.trace.span_id

  const dispatch: WireDef.Dispatch = {
    k: 'dispatch',
    cid,
    service: remote.service,
    action: remote.action,
    args,
    trace: toWire(remote.trace),
    inputs: inputs.map(lane => ({ name: lane.name, brand: lane.brand })),
    deadline: remote.deadline,
    idempotencyKey: remote.idempotencyKey,
    meta: remote.meta,
  }

  return yield* withSpan(
    {
      kernel,
      trace: remote.trace,
      kind: 'carrier',
      name: `${remote.service}.${remote.action}`,
      actionId: `${remote.service}.${remote.action}`,
      transport: (yield* useContext(carrier)).transport,
    },
    function* () {
      const sent = yield* carrier.actions.send(dispatch, inputs)
      const [output] = sent.reply.outputs
      if (output) {
        return yield* sent.lane(output.name)
      }
      return sent.reply.value
    },
  )
}

export function* carrierOf(kernel: ServerDef.Context): Operation<CarrierDef> {
  if (!kernel.carrier) {
    return yield* fail(ServerErrors.Configuration, 'the server has no carrier yet (createServer)')
  }

  return kernel.carrier
}

/** Where a call's trace continues from: the running dispatch/span, or a fresh internal root. */
export function* traceFor(
  kernel: ServerDef.Context,
  service: string,
  action: string,
): Operation<TraceDef.Trace> {
  const parent = yield* TraceRef.get()
  const base = parent ? yield* childTrace(parent) : yield* rootTrace(kernel.serviceId, 'internal')

  const hop: TraceDef.Hop = {
    service,
    action,
    span_id: base.span_id,
    transport: kernel.registry.services.has(service) ? 'local' : 'carrier',
    ts: Date.now(),
  }

  return { ...base, lane: [...base.lane, hop] }
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

function* outcomeOf(kernel: ServerDef.Context, outcome: TraceDef.Outcome): Operation<void> {
  if (kernel.outcomes) {
    yield* attempt(() => kernel.outcomes!.actions.put(outcome))
  }
}

/** Run `body` as the root of a request: `TraceRef` is set so the inner call is a child, and a
 * request row is reported when it ends. */
export function* asRequest<T>({ kernel, trace, target, body }: Helpers.RootCall<T>): Operation<T> {
  const startedAt = Date.now()
  const root: TraceDef.Trace = { ...trace, span_id: `${trace.span_id}-root`, lane: [] }
  const outcome = yield* TraceRef.with(root, () => attempt(body))
  const endedAt = Date.now()
  const failure = isFailure(outcome) ? outcome : null

  yield* report(kernel, {
    t: 'request',
    row: {
      request_id: trace.request_id,
      origin: trace.origin,
      service: target.service,
      action: target.action,
      edge: null,
      method: null,
      path: null,
      socket: null,
      status: failure ? statusOf(failure) : 200,
      service_id: kernel.serviceId,
      instance: kernel.instance,
      lane: laneOf(trace.lane),
      started_at: startedAt,
      ended_at: endedAt,
      duration_ms: endedAt - startedAt,
      error: failure ? String(failure.error) : null,
      attrs: null,
      headers: null,
      input: null,
      output: null,
    },
  })

  if (isFailure(outcome)) {
    return yield* outcome
  }

  return outcome.value
}

/** The kernel's own actions as the dispatch pipeline needs them (bound, no dispatch cost). */
export const actionsOf = (kernel: ServerDef.Context) => ({
  call: Server.actions.call,
  emit: Server.actions.emit,
  outcome: (outcome: TraceDef.Outcome) => outcomeOf(kernel, outcome),
})

/** Install a plugin entry (`Plugin.use(...args)`, or a bare handle); resolves its
 * context. */
export function* installEntry(entry: ServerDef.PluginLike): Operation<unknown> {
  if (isUse(entry)) {
    return yield* entry
  }

  return yield* install(entry as Plugin<AnyType, [], AnyType>)
}

/** The serving side of one service: what the carrier calls for a dispatch arriving here. */
export const serverFor = (
  kernel: ServerDef.Context,
  service: ServiceDef.Service,
): CarrierDef.Server =>
  function* (dispatch, inputs) {
    const def = service.actions[dispatch.action]

    if (!def || isSocketAction(def)) {
      return yield* fail(ServerErrors.NotFound, `no action "${service.name}.${dispatch.action}"`)
    }

    const trace = yield* continueTrace(dispatch.trace, kernel.serviceId)

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
    const controller = new AbortController()
    const carrierName = kernel.carrier ? (yield* useContext(kernel.carrier)).transport : 'local'

    const call: ServerDef.Call = {
      cid: dispatch.cid,
      service: service.name,
      action: dispatch.action,
      input,
      trace,
      headers: dispatch.meta ?? {},
      deadline: dispatch.deadline,
      idempotencyKey: dispatch.idempotencyKey,
      transport: carrierName,
      signal: controller.signal,
      abort: reason => controller.abort(reason),
    }

    yield* ensure(() => {
      if (!controller.signal.aborted) {
        controller.abort(ServerErrors.Cancelled)
      }
    })
    const outcome = yield* runDispatch(kernel, call, actionsOf(kernel))

    if (isFailure(outcome)) {
      return yield* outcome
    }

    const { value } = outcome

    if (isDeferred(value)) {
      // materialized by the consumer (local caller / carrier pipe job) in its own scope
      return {
        value: undefined,
        outputs: [{ name: 'body', brand: value.brand, open: () => materialize(value) as AnyType }],
      }
    }

    if (isBranded(value)) {
      return {
        value: undefined,

        outputs: [
          {
            name: 'body',
            brand: brandOf(value),
            *open() {
              return value
            },
          },
        ],
      }
    }

    return { value, outputs: [] }
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
