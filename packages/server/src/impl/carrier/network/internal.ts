// oxlint-disable import/exports-last
import type { CarrierDef, ServerDef, StreamDef } from 'server:core'
import { report, ServerErrors, stream } from 'server:core'
import type { Operation } from 'std:effect'
import { attempt, createContext, fork, sleep } from 'std:effect'
import type { Result } from 'std:result'
import { fail, isFailure } from 'std:result'
import type { AnyType } from 'std:shared'

import { TransportErrors } from 'transport:core'

import type { NetworkCarrierDef } from './types'

export const StateRef = createContext<NetworkCarrierDef.State>('server:impl/carrier/network')

/** Topics under the transport's application prefix. */
export const topics = {
  rpc: (service: string): string => `rpc.${service}`,
  event: (name: string): string => `event.${name}`,
  events: 'event.>',
  lane: (cid: string, direction: 'in' | 'out', name: string): string =>
    `lane.${cid}.${direction}.${name}`,
}

/** A transport failure as the caller's fulfillment-model failure. */
export function* raise(failure: Result.Failure<unknown>, where: string): Operation<never> {
  switch (failure.error) {
    case TransportErrors.NoResponders: {
      return yield* fail(ServerErrors.Unavailable, `${where}: nobody serves it`, ...failure.causes)
    }

    case TransportErrors.Timeout: {
      return yield* fail(
        ServerErrors.TimeoutPending,
        `${where}: no reply in time (the handler may still be running)`,
        ...failure.causes,
      )
    }
    case TransportErrors.Closed:
    case TransportErrors.Connection: {
      return yield* fail(ServerErrors.Unavailable, `${where}: carrier down`, ...failure.causes)
    }

    default: {
      // a business failure from the owner travels with its own tag
      return yield* failure
    }
  }
}

/** Pipe a branded stream over a lane (values or bytes, the brand decides nothing here: the
 * transport's flow plane carries both). */
export function* pipeLane(
  state: NetworkCarrierDef.State,
  topic: string,
  source: StreamDef.Branded<string, AnyType>,
): Operation<void> {
  const outcome = yield* attempt(() =>
    state.actions.pipe(topic, stream.flow(source), { timeoutMs: state.laneTimeoutMs }),
  )

  if (isFailure(outcome)) {
    // the other end never attached / went away: the stream is abandoned, not the request
    return
  }
}

/** Attach to a lane as a branded stream (the consumer side). */
export function* attachLane(
  state: NetworkCarrierDef.State,
  topic: string,
  brand: string,
): Operation<StreamDef.Branded> {
  const flow = state.actions.flow<AnyType, unknown>(topic, { timeoutMs: state.laneTimeoutMs })
  return yield* stream.of(flow, brand)
}

// --- presence -------------------------------------------------------------------------------

const PRESENCE_TOPIC = 'presence.>'
const presenceTopic = (instance: string): string => `presence.${instance}`

/** This node's heartbeat, from the kernel's identity and what it serves. */
const heartbeatOf = (
  kernel: ServerDef.Context,
  state: NetworkCarrierDef.State,
  k: NetworkCarrierDef.Heartbeat['k'],
): NetworkCarrierDef.Heartbeat => ({
  k,
  instance: kernel.instance,
  serviceId: kernel.serviceId,
  services: [...state.serving.keys()].map(name => ({
    name,
    version: kernel.registry.services.get(name)?.version ?? kernel.version,
  })),
  draining: state.presence?.draining ?? false,
  ts: Date.now(),
})

/** Apply one heartbeat to the members table. */
const absorb = (presence: NetworkCarrierDef.Presence, beat: NetworkCarrierDef.Heartbeat): void => {
  if (beat.k === 'leave') {
    for (const members of presence.members.values()) {
      const member = members.get(beat.instance)

      if (member) {
        members.set(beat.instance, { ...member, draining: true, seenAt: beat.ts })
      }
    }

    return
  }

  const names = new Set(beat.services.map(entry => entry.name))

  // a service this node no longer announces is gone from its row
  for (const [service, members] of presence.members) {
    if (!names.has(service)) {
      members.delete(beat.instance)

      if (members.size === 0) {
        presence.members.delete(service)
      }
    }
  }

  for (const entry of beat.services) {
    let members = presence.members.get(entry.name)

    if (!members) {
      members = new Map()
      presence.members.set(entry.name, members)
    }

    members.set(beat.instance, {
      instance: beat.instance,
      serviceId: beat.serviceId,
      version: entry.version,
      seenAt: beat.ts,
      draining: beat.draining,
    })
  }
}

/** Drop members unseen for longer than the ttl. */
const sweep = (presence: NetworkCarrierDef.Presence, now: number): void => {
  for (const [service, members] of presence.members) {
    for (const [instance, member] of members) {
      if (now - member.seenAt > presence.ttlMs) {
        members.delete(instance)
      }
    }

    if (members.size === 0) {
      presence.members.delete(service)
    }
  }
}

/** Every known member of a service: this node first when it serves it, then the peers. */
export const membersOf = (
  state: NetworkCarrierDef.State,
  service: string,
): readonly CarrierDef.Member[] => {
  const peers = [...(state.presence?.members.get(service)?.values() ?? [])]
  const { kernel } = state

  if (!kernel || !state.serving.has(service)) {
    return peers
  }

  return [
    {
      instance: kernel.instance,
      serviceId: kernel.serviceId,
      version: kernel.registry.services.get(service)?.version ?? kernel.version,
      seenAt: Date.now(),
      draining: state.presence?.draining ?? false,
    },
    ...peers,
  ]
}

/** Announce now (a heartbeat, or a `leave`). Publish failures are swallowed: presence is
 * best-effort, the rpc plane still decides delivery. */
export function* announce(
  kernel: ServerDef.Context,
  state: NetworkCarrierDef.State,
  k: NetworkCarrierDef.Heartbeat['k'],
): Operation<void> {
  yield* attempt(() =>
    state.actions.publish(presenceTopic(kernel.instance), heartbeatOf(kernel, state, k), {
      transient: true,
    }),
  )
}

/** A peer announcing a service at another version than ours: one warning per (peer, service)
 * — normal during a rolling deploy, worth seeing when it persists. */
function* warnVersions(
  kernel: ServerDef.Context,
  beat: NetworkCarrierDef.Heartbeat,
  warned: Set<string>,
): Operation<void> {
  for (const entry of beat.services) {
    const local = kernel.registry.services.get(entry.name)?.version
    const key = `${beat.instance}/${entry.name}`

    if (local === undefined || local === entry.version || warned.has(key)) {
      continue
    }

    warned.add(key)

    yield* report(kernel, {
      t: 'log',
      row: {
        requestId: null,
        spanId: null,
        level: 'warn',
        msg: `presence: ${entry.name} runs ${entry.version} on ${beat.instance}, ${local} here`,
        data: { service: entry.name, instance: beat.instance, theirs: entry.version, ours: local },
        ts: Date.now(),
      },
    })
  }
}

/**
 * The presence loop: subscribe to every node's heartbeats (answering `hello` with an immediate
 * re-announce so a newcomer learns the cluster at once), heartbeat on the period, sweep the
 * expired. Runs as a task of the carrier's scope.
 */
export function* runPresence(
  kernel: ServerDef.Context,
  state: NetworkCarrierDef.State,
): Operation<void> {
  const presence = state.presence!
  const warned = new Set<string>()

  yield* fork(function* () {
    const subscription = yield* state.actions.subscribe<NetworkCarrierDef.Heartbeat>(
      PRESENCE_TOPIC,
      { transient: true },
    )
    for (;;) {
      const step = yield* subscription.next()
      if (step.done) {
        return
      }
      const beat = step.value.value
      if (!beat || beat.instance === kernel.instance) {
        continue
      }
      absorb(presence, beat)
      yield* warnVersions(kernel, beat, warned)
      if (beat.k === 'hello') {
        yield* announce(kernel, state, 'presence')
      }
    }
  })
  yield* announce(kernel, state, 'hello')

  for (;;) {
    yield* sleep(presence.heartbeatMs)
    sweep(presence, Date.now())
    yield* announce(kernel, state, 'presence')
  }
}

/**
 * Wait for a live member of a service: live → now; only draining members → up to `waitMs` for
 * a live one (then the draining ones still answer); nobody → `server.unavailable` at once.
 */
export function* ensureMember(state: NetworkCarrierDef.State, service: string): Operation<void> {
  const presence = state.presence

  if (!presence) {
    return
  }

  const deadline = Date.now() + presence.waitMs

  for (;;) {
    const members = membersOf(state, service)

    if (members.some(member => !member.draining)) {
      return
    }

    if (members.length === 0) {
      return yield* fail(
        ServerErrors.Unavailable,
        `${service}: no node hosts it (presence knows ${presence.members.size} service(s))`,
      )
    }

    if (Date.now() >= deadline) {
      return
    }

    yield* sleep(50)
  }
}
