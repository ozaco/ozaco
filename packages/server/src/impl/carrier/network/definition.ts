import type { CarrierDef, WireDef } from 'server:core'
import { Carrier, carrierDefaults, Server, ServerErrors } from 'server:core'
import type { Operation } from 'std:effect'
import { attempt, createQueue, ensure, fork, useContext } from 'std:effect'
import { fail, isFailure } from 'std:result'
import type { AnyType } from 'std:shared'

import type { TransportDef } from 'transport:core'
import { Transport } from 'transport:core'

import pkg from '../../../../package.json'

import {
  announce,
  attachLane,
  ensureMember,
  membersOf,
  pipeLane,
  raise,
  runPresence,
  StateRef,
  topics,
} from './internal'
import type { NetworkCarrierDef } from './types'

/**
 * The cross-node carrier over an `@ozaco/transport`: RPC on the package plane
 * (`rpc.<service>`, one competing group per service), streams on lanes (`lane.<cid>.{in,out}.<name>`
 * over the flow plane — values or bytes), events on the event plane (`event.<name>`), cancel by
 * the transport's own request-halt propagation. Failures keep their tags; transport failures
 * become `server.unavailable` / `server.timeout-pending`.
 */
export const NetworkCarrier: CarrierDef.Handle = Carrier.implement<
  CarrierDef.Options,
  [options?: NetworkCarrierDef.Options]
>({
  name: 'server-carrier-network',
  version: pkg.version,
  description: 'Cross-node carrier over @ozaco/transport',

  *setup(options) {
    const actions: TransportDef.Actions = (options?.transport?.actions ??
      Transport.actions) as AnyType
    const described = yield* attempt(() => actions.describe())
    if (isFailure(described)) {
      return yield* fail(
        ServerErrors.Configuration,
        'NetworkCarrier needs a transport installed before it (MemoryTransport, NatsTransport, …)',
        ...described.causes,
      )
    }
    const kernel = yield* Server.context.get()
    const heartbeatMs = options?.presence === false ? 0 : (options?.presence?.heartbeatMs ?? 5000)
    const state: NetworkCarrierDef.State = {
      actions,
      transport: described.value.transport,
      laneTimeoutMs: options?.laneTimeoutMs ?? 5000,
      jobs: createQueue(),
      serving: new Map(),
      kernel: kernel ?? null,
      presence:
        options?.presence === false || !kernel
          ? null
          : {
              heartbeatMs,
              ttlMs: options?.presence?.ttlMs ?? heartbeatMs * 3,
              waitMs: options?.presence?.waitMs ?? 2000,
              members: new Map(),
              draining: false,
            },
    }
    yield* StateRef.set(state)
    if (state.presence && kernel) {
      yield* fork(() => runPresence(kernel, state))
    }
    // lane pipes announced by a reply outlive the reply: they run here, in the carrier's scope
    yield* fork(function* () {
      for (;;) {
        const job = yield* state.jobs.next()
        if (job.done) {
          return
        }
        yield* fork(job.value)
      }
    })
    yield* ensure(() => {
      state.jobs.close(undefined)
    })
    return { carrier: 'network', transport: state.transport }
  },
}).build({
  ...carrierDefaults(),

  *hosts(service) {
    const state = yield* useContext(StateRef)
    if (!state.presence) {
      // the transport answers `no-responders` when nobody does: optimistic here
      return true
    }
    return membersOf(state, service).some(member => !member.draining)
  },

  *members(service) {
    return membersOf(yield* useContext(StateRef), service)
  },

  *send(dispatch, inputs) {
    const state = yield* useContext(StateRef)
    yield* ensureMember(state, dispatch.service)
    // input streams ride alongside: piped from this scope, consumed by the owner as it reads
    for (const lane of inputs) {
      yield* fork(() => pipeLane(state, topics.lane(dispatch.cid, 'in', lane.name), lane.source))
    }
    const timeoutMs = Math.max(1, dispatch.deadline - Date.now())
    const outcome = yield* attempt(() =>
      state.actions.request<WireDef.Reply, WireDef.Dispatch>(
        topics.rpc(dispatch.service),
        dispatch,
        {
          timeoutMs,
        },
      ),
    )
    if (isFailure(outcome)) {
      return yield* raise(outcome, `${dispatch.service}.${dispatch.action}`)
    }
    const reply = outcome.value
    const outputs = new Map(reply.outputs.map(lane => [lane.name, lane.brand]))
    return {
      reply,
      *lane(name) {
        const brand = outputs.get(name)
        if (brand === undefined) {
          return yield* fail(ServerErrors.Internal, `no output stream "${name}"`)
        }
        return yield* attachLane(state, topics.lane(dispatch.cid, 'out', name), brand)
      },
    }
  },

  *serve(service, server) {
    const state = yield* useContext(StateRef)
    const stop = yield* state.actions.serve<WireDef.Dispatch, WireDef.Reply>(
      topics.rpc(service),
      function* (dispatch) {
        const served = yield* server(dispatch, name => {
          const lane = dispatch.inputs.find(entry => entry.name === name)
          return attachLane(
            state,
            topics.lane(dispatch.cid, 'in', name),
            lane?.brand ?? 'bytes:application/octet-stream',
          )
        })
        for (const lane of served.outputs) {
          state.jobs.add(function* () {
            // opened here, in the carrier's scope: the handler's is gone once the reply is out
            const source = yield* lane.open()
            yield* pipeLane(state, topics.lane(dispatch.cid, 'out', lane.name), source)
          })
        }
        return {
          k: 'reply',
          cid: dispatch.cid,
          value: served.value,
          outputs: served.outputs.map(lane => ({ name: lane.name, brand: lane.brand })),
        }
      },
      { group: service },
    )
    state.serving.set(service, stop)
    const kernel = yield* Server.context.get()
    if (kernel && state.presence) {
      yield* announce(kernel, state, 'presence')
    }
  },

  *unserve(service) {
    const state = yield* useContext(StateRef)
    const stop = state.serving.get(service)
    if (!stop) {
      return
    }
    state.serving.delete(service)
    yield* attempt(stop)
  },

  *leave() {
    const state = yield* useContext(StateRef)
    const kernel = yield* Server.context.get()
    if (!state.presence || !kernel) {
      return
    }
    state.presence.draining = true
    yield* announce(kernel, state, 'leave')
  },

  *emit(event) {
    const state = yield* useContext(StateRef)
    yield* state.actions.publish(topics.event(event.name), event)
  },

  events: () => ({
    *[Symbol.iterator]() {
      const state = yield* useContext(StateRef)
      const subscription = yield* state.actions.subscribe<WireDef.Event>(topics.events)
      return {
        *next(): Operation<IteratorResult<WireDef.Event, never>> {
          for (;;) {
            const step = yield* subscription.next()
            if (step.done) {
              continue
            }
            return { done: false, value: step.value.value }
          }
        },
      }
    },
  }),

  *cancel() {
    // the transport's package plane propagates a caller's halt as `$cancel.<cid>` by itself
  },

  status: () => ({
    *[Symbol.iterator]() {
      const state = yield* useContext(StateRef)
      return yield* state.actions.status()
    },
  }),
})
