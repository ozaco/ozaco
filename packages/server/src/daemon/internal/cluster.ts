import { until } from 'std:effect'
import { fail } from 'std:result'
import type { AnyType } from 'std:shared'

import { DAEMON_ENV, DaemonErrors } from '../const'
import type { DaemonDef } from '../types'

import type { ResolvedFailure } from './failure'

export const forkCluster = function* (
  replicate: DaemonDef.Replicate,
  mode: DaemonDef.Mode,
  failure: ResolvedFailure,
) {
  const mod = (yield* until(import('node:cluster'))) as AnyType
  const cluster = (mod.default ?? mod) as AnyType

  // env + run count per worker, so the supervisor can replace exactly what crashed
  const slots = new Map<AnyType, { env: Record<string, string>; runs: number }>()

  const spawn = (env: Record<string, string>, runs: number): AnyType => {
    const worker = cluster.fork(env) as AnyType
    slots.set(worker, { env, runs })
    return worker
  }

  const fork = (extra: Record<string, string>): AnyType =>
    spawn({ [DAEMON_ENV.strategy]: 'cluster', [DAEMON_ENV.mode]: mode, ...extra }, 1)

  if (mode === 'roles') {
    const roles = replicate.roles ?? {}
    if (Object.keys(roles).length === 0) {
      return yield* fail(DaemonErrors.Spawn, 'cluster roles mode requires replicate.roles')
    }
    for (const [role, count] of Object.entries(roles)) {
      for (let i = 0; i < count; i++) {
        fork({ [DAEMON_ENV.role]: role })
      }
    }
  } else {
    const os = (yield* until(import('node:os'))) as AnyType
    const count = replicate.count ?? os.cpus().length
    for (let i = 0; i < count; i++) {
      fork({})
    }
  }

  const teardown = () => {
    for (const worker of Object.values(cluster.workers ?? {})) {
      ;(worker as AnyType)?.kill?.()
    }
    // oxlint-disable-next-line no-process-exit
    process.exit(1)
  }

  cluster.on('exit', (worker: AnyType, code: number, signal: string) => {
    const slot = slots.get(worker)
    slots.delete(worker)
    // a clean shutdown (intentional signal or exit 0) is never restarted
    if (!slot || signal || code === 0) {
      return
    }

    if (slot.runs < failure.retry.attempts) {
      const { delay, backoff, maxDelay } = failure.retry
      const wait = Math.min(delay * backoff ** (slot.runs - 1), maxDelay)
      const respawn = () => spawn(slot.env, slot.runs + 1)
      if (wait > 0) {
        setTimeout(respawn, wait)
      } else {
        respawn()
      }
      return
    }

    // retries exhausted: `all` tears the whole daemon down, `isolate` abandons just this slot
    if (failure.mode === 'all') {
      teardown()
    }
  })
}
