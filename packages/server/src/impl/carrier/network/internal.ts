// oxlint-disable import/exports-last
import type { CarrierDef, ServerDef, StreamDef } from 'server:core'
import { ServerErrors, stream } from 'server:core'
import { scopeOf } from 'server:internal'
import type { Operation } from 'std:effect'
import { attempt, createContext, fork, sleep } from 'std:effect'
import { Logger, LogLevel } from 'std:logger'
import type { Result } from 'std:result'
import { fail, formatFailure, isFailure } from 'std:result'
import type { AnyType } from 'std:shared'
import { emitLog } from 'std:trace'

import { logAttributes, severityOf } from 'std:logger/transport/trace'
import { TransportErrors } from 'transport:core'

import type { NetworkCarrierDef } from './types'

export const StateRef = createContext<NetworkCarrierDef.State>('server:impl/carrier/network')

/** The instrumentation scope (and `logger` binding) of this carrier's operational log lines. */
const LOG_SCOPE = scopeOf('carrier/network')

/**
 * One operational log line of the carrier (presence changes, draining waits, version skew,
 * abandoned lanes): through the installed std Logger (`logger` binding = this carrier's scope —
 * it reaches the sinks through the Logger's `TraceTransport`), else straight to the Tracer as a
 * log record. Never fails the carrier.
 */
export function* opLog(
  level: 'info' | 'warn',
  msg: string,
  data: Readonly<Record<string, unknown>>,
): Operation<void> {
  yield* attempt(function* () {
    if ((yield* Logger.context.get()) !== undefined) {
      yield* Logger.actions.child({ logger: LOG_SCOPE.name }, () =>
        Logger.actions[level](msg, data as Record<string, unknown>),
      )
      return
    }

    const severity = severityOf(level === 'warn' ? LogLevel.warn : LogLevel.info)

    yield* emitLog({
      body: msg,
      severityNumber: severity.number,
      severityText: severity.text,
      attributes: logAttributes(data),
      scope: LOG_SCOPE,
    })
  })
}

/** Events named `_…` (the observe cluster) are plumbing: published transient (never persisted)
 * and delivered on the transient plane. */
export const isInternalEvent = (name: string): boolean => name.startsWith('_')

/** Topics under the transport's application prefix. */
export const topics = {
  rpc: (service: string): string => `rpc.${service}`,
  event: (name: string): string => `event.${name}`,
  events: 'event.>',
  lane: (cid: string, direction: 'in' | 'out', name: string): string =>
    `lane.${cid}.${direction}.${name}`,
}

/** A transport failure as the caller's fulfillment-model failure (the transport's failure kept
 * as a nested cause). */
export function* raise(failure: Result.Failure<unknown>, where: string): Operation<never> {
  switch (failure.error) {
    case TransportErrors.NoResponders: {
      return yield* fail(ServerErrors.Unavailable, `${where}: nobody serves it`, failure)
    }

    case TransportErrors.Timeout: {
      return yield* fail(
        ServerErrors.TimeoutPending,
        `${where}: no reply in time (the handler may still be running)`,
        failure,
      )
    }
    case TransportErrors.Closed:
    case TransportErrors.Connection: {
      return yield* fail(ServerErrors.Unavailable, `${where}: carrier down`, failure)
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
    yield* opLog('info', `lane ${topic} abandoned: ${formatFailure(outcome)}`, {
      'ozaco.lane.topic': topic,
    })
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

/** Apply one heartbeat to the members table; resolves what changed (for the presence log). */
const absorb = (
  presence: NetworkCarrierDef.Presence,
  beat: NetworkCarrierDef.Heartbeat,
): { readonly joined: readonly string[]; readonly draining: boolean } => {
  if (beat.k === 'leave') {
    let draining = false

    for (const members of presence.members.values()) {
      const member = members.get(beat.instance)

      if (member) {
        draining ||= !member.draining
        members.set(beat.instance, { ...member, draining: true, seenAt: beat.ts })
      }
    }

    return { joined: [], draining }
  }

  const names = new Set(beat.services.map(entry => entry.name))
  const joined: string[] = []

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

    if (!members.has(beat.instance)) {
      joined.push(entry.name)
    }

    members.set(beat.instance, {
      instance: beat.instance,
      serviceId: beat.serviceId,
      version: entry.version,
      seenAt: beat.ts,
      draining: beat.draining,
    })
  }

  return { joined, draining: false }
}

/** Drop members unseen for longer than the ttl; resolves the `instance/service` pairs dropped. */
const sweep = (presence: NetworkCarrierDef.Presence, now: number): string[] => {
  const expired: string[] = []

  for (const [service, members] of presence.members) {
    for (const [instance, member] of members) {
      if (now - member.seenAt > presence.ttlMs) {
        members.delete(instance)
        expired.push(`${instance}/${service}`)
      }
    }

    if (members.size === 0) {
      presence.members.delete(service)
    }
  }

  return expired
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

    yield* opLog(
      'warn',
      `presence: ${entry.name} runs ${entry.version} on ${beat.instance}, ${local} here`,
      {
        'ozaco.presence.service': entry.name,
        'ozaco.presence.instance': beat.instance,
        'ozaco.presence.version': entry.version,
        'ozaco.presence.version.local': local,
      },
    )
  }
}

/**
 * The presence loop: subscribe to every node's heartbeats (answering `hello` with an immediate
 * re-announce so a newcomer learns the cluster at once), heartbeat on the period, sweep the
 * expired. Runs as a task of the carrier's scope.
 *
 * The subscription is LIVE before the `hello` goes out: plain pub/sub keeps nothing for a late
 * subscriber, so a `hello` sent first would miss every peer still subscribing (and this node
 * the answers) — nodes starting together would then know nobody until the next heartbeat. With
 * subscribe-then-hello, of any two nodes the one subscribed later says `hello` to one already
 * listening, and hears its answer.
 */
export function* runPresence(
  kernel: ServerDef.Context,
  state: NetworkCarrierDef.State,
): Operation<void> {
  const presence = state.presence!
  const warned = new Set<string>()

  // bound to this task's scope (the loop below only reads it)
  const subscription = yield* state.actions.subscribe<NetworkCarrierDef.Heartbeat>(PRESENCE_TOPIC, {
    transient: true,
  })

  yield* fork(function* () {
    for (;;) {
      const step = yield* subscription.next()
      if (step.done) {
        return
      }
      const beat = step.value.value
      if (!beat || beat.instance === kernel.instance) {
        continue
      }
      const changed = absorb(presence, beat)

      if (changed.joined.length > 0) {
        yield* opLog('info', `presence: ${beat.instance} serves ${changed.joined.join(', ')}`, {
          'ozaco.presence.instance': beat.instance,
          'ozaco.presence.services': changed.joined,
        })
      }

      if (changed.draining) {
        yield* opLog('info', `presence: ${beat.instance} is draining`, {
          'ozaco.presence.instance': beat.instance,
        })
      }

      yield* warnVersions(kernel, beat, warned)
      if (beat.k === 'hello') {
        yield* announce(kernel, state, 'presence')
      }
    }
  })
  yield* announce(kernel, state, 'hello')

  for (;;) {
    yield* sleep(presence.heartbeatMs)
    const expired = sweep(presence, Date.now())

    if (expired.length > 0) {
      yield* opLog('info', `presence: ${expired.join(', ')} expired`, {
        'ozaco.presence.expired': expired,
      })
    }

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
  let waiting = false

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
      yield* opLog('warn', `${service}: no live member after ${presence.waitMs}ms`, {
        'ozaco.presence.service': service,
        'ozaco.presence.draining': members.length,
      })
      return
    }

    if (!waiting) {
      waiting = true
      yield* opLog('info', `${service}: only draining members, waiting for a live one`, {
        'ozaco.presence.service': service,
        'ozaco.presence.draining': members.length,
      })
    }

    yield* sleep(50)
  }
}
