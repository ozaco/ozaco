// oxlint-disable import/exports-last
import type { Operation } from 'std:effect'
import { sleep } from 'std:effect'
import { fail } from 'std:result'

import { ServerErrors } from '../errors'
import type { CarrierDef } from '../types/carrier'
import type { Helpers } from '../types/helpers'
import type { ServerDef } from '../types/server'

/** The node's shape: role, hosted set, readiness — everything `start()`/`stop()`/`/_health`
 * read. One place decides it (the env convention included), so a deployment is described by
 * `createServer` options alone. */
export const env = (name: string): string | undefined =>
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name]

const namedServices = (): readonly string[] | undefined => {
  const named = env('SERVICE')
    ?.split(',')
    .map(name => name.trim())
    .filter(Boolean)

  return named && named.length > 0 ? named : undefined
}

export const roleOf = (options: ServerDef.Options): ServerDef.Role =>
  options.role ?? (namedServices() ? 'service' : 'monolith')

export const hostedOf = (options: ServerDef.Options, role: ServerDef.Role): readonly string[] => {
  if (role === 'gateway') {
    return []
  }

  if (options.hosted) {
    return options.hosted
  }

  const all = options.services.map(def => def.name)
  const named = namedServices()

  return role === 'service' && named ? named : all
}

/** The services `start()` waits for. Default by role: a `service` node does its own work and
 * waits for NOBODY (readiness = its own services are up — a sequential rollout's first pod must
 * be able to start); gateway/monolith wait for everything they would forward to (a call they
 * cannot forward must be a 503, not a surprise). */
const dependsOnOf = (state: Helpers.NodeState): readonly string[] =>
  state.options.dependsOn ??
  (state.role === 'service'
    ? []
    : state.options.services.map(def => def.name).filter(name => !state.hosted.includes(name)))

export const infoOf = (state: Helpers.NodeState): ServerDef.Info => ({
  role: state.role,
  hosted: state.hosted,
  url: state.url,
  port: state.port,
  started: state.started,
  ready: state.ready,
})

/** Every declared service with its members (this node's own included). */
export function* membersOf(
  state: Helpers.NodeState,
  members: (service: string) => Operation<readonly CarrierDef.Member[]>,
): Operation<Record<string, readonly CarrierDef.Member[]>> {
  const out: Record<string, readonly CarrierDef.Member[]> = {}

  for (const def of state.options.services) {
    out[def.name] = yield* members(def.name)
  }

  return out
}

export function* healthOf(
  state: Helpers.NodeState,
  kernel: ServerDef.Context,
  members: (service: string) => Operation<readonly CarrierDef.Member[]>,
): Operation<ServerDef.Health> {
  return {
    ok: true,
    ready: state.ready,
    role: state.role,
    hosted: state.hosted,
    serviceId: kernel.serviceId,
    members: yield* membersOf(state, members),
  }
}

/** Wait until every `dependsOn` service has a live member (bounded). */
export function* awaitDependencies(
  state: Helpers.NodeState,
  members: (service: string) => Operation<readonly CarrierDef.Member[]>,
): Operation<void> {
  const wanted = dependsOnOf(state)
  const deadline = Date.now() + (state.options.readyTimeoutMs ?? 30_000)

  for (;;) {
    const missing: string[] = []

    for (const service of wanted) {
      const live = yield* members(service)

      if (!live.some(member => !member.draining)) {
        missing.push(service)
      }
    }

    if (missing.length === 0) {
      return
    }

    if (Date.now() >= deadline) {
      return yield* fail(
        ServerErrors.Unavailable,
        `not ready: no live member for ${missing.join(', ')}`,
      )
    }

    yield* sleep(100)
  }
}
