// oxlint-disable import/exports-last
import type { CarrierDef, ServerDef } from 'server:core'
import { ServerErrors } from 'server:core'
import type { Operation } from 'std:effect'
import { sleep } from 'std:effect'
import { fail } from 'std:result'

import type { AppDef } from './types'

export const env = (name: string): string | undefined =>
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name]

export const roleOf = (options: AppDef.Options): AppDef.Role =>
  options.role ?? (env('SERVICE') ? 'service' : 'monolith')

export const hostedOf = (options: AppDef.Options, role: AppDef.Role): readonly string[] => {
  const all = options.services.map(def => def.name)

  if (role === 'gateway') {
    return []
  }

  if (options.hosted) {
    return options.hosted
  }

  const named = env('SERVICE')
    ?.split(',')
    .map(name => name.trim())
    .filter(Boolean)

  return role === 'service' && named && named.length > 0 ? named : all
}

export const infoOf = (state: AppDef.State): AppDef.Info => ({
  role: state.role,
  hosted: state.hosted,
  url: state.url,
  started: state.started,
  ready: state.ready,
})

/** The services `start()` waits for. Default by role: a `service` node does its own work and
 * waits for NOBODY (readiness = its own services are up — a sequential rollout's first pod
 * must be able to start); gateway/monolith wait for everything they would forward to (a call
 * they cannot forward must be a 503, not a surprise). */
const dependsOnOf = (state: AppDef.State): readonly string[] =>
  state.options.dependsOn ??
  (state.role === 'service'
    ? []
    : state.options.services.map(def => def.name).filter(name => !state.hosted.includes(name)))

/** Every declared service with its members (this node's own included). */
export function* membersOf(
  state: AppDef.State,
): Operation<Record<string, readonly CarrierDef.Member[]>> {
  const out: Record<string, readonly CarrierDef.Member[]> = {}

  for (const def of state.options.services) {
    out[def.name] = yield* state.server.members(def.name)
  }

  return out
}

export function* healthOf(
  state: AppDef.State,
  kernel: ServerDef.Context,
): Operation<AppDef.Health> {
  return {
    ok: true,
    ready: state.ready,
    role: state.role,
    hosted: state.hosted,
    serviceId: kernel.serviceId,
    members: yield* membersOf(state),
  }
}

/** Wait until every `dependsOn` service has a live member (bounded). */
export function* awaitDependencies(state: AppDef.State): Operation<void> {
  const wanted = dependsOnOf(state)
  const deadline = Date.now() + (state.options.readyTimeoutMs ?? 30_000)

  for (;;) {
    const missing: string[] = []

    for (const service of wanted) {
      const members = yield* state.server.members(service)

      if (!members.some(member => !member.draining)) {
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
