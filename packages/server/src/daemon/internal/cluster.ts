import { until } from 'std:effect'
import type { AnyType } from 'std:shared'

import { DAEMON_ENV } from '../const'
import type { DaemonDef } from '../types'

import type { ResolvedFailure } from './failure'

/**
 * Fork one child per module, each owning exactly that module (`SERVICE=<name>`). The primary does not
 * return here — it goes on to be the gateway, so a single `cluster: true` reproduces the Kubernetes
 * shape (one gateway + one process per service) on one machine.
 *
 * `when` is evaluated against the primary's runtime: the whole cluster shares one environment, so a
 * module gated off by a missing flag gets no child at all.
 */
export const forkCluster = function* (
  modules: DaemonDef.Module[],
  rt: DaemonDef.Runtime,
  failure: ResolvedFailure,
) {
  const mod = (yield* until(import('node:cluster'))) as AnyType
  const cluster = (mod.default ?? mod) as AnyType

  // env + run count per child, so the supervisor can replace exactly what crashed
  const slots = new Map<AnyType, { env: Record<string, string>; runs: number }>()

  const spawn = (env: Record<string, string>, runs: number): AnyType => {
    const worker = cluster.fork(env) as AnyType
    slots.set(worker, { env, runs })
    return worker
  }

  for (const module of modules) {
    if (module.when !== undefined && !module.when(rt)) {
      continue
    }
    spawn({ [DAEMON_ENV.service]: module.name }, 1)
  }

  // Set the moment WE start killing children, which is the only way to tell an intentional stop from
  // a signal the OS delivered on its own. Treating every signal as intentional meant an OOM kill was
  // indistinguishable from a clean shutdown, so the module it hosted simply stayed down forever and
  // its routes 500'd for the life of the process.
  let stopping = false

  const teardown = () => {
    stopping = true
    for (const worker of Object.values(cluster.workers ?? {})) {
      ;(worker as AnyType)?.kill?.()
    }
    // oxlint-disable-next-line no-process-exit
    process.exit(1)
  }

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      stopping = true
    })
  }

  cluster.on('exit', (worker: AnyType, code: number, signal: string) => {
    const slot = slots.get(worker)
    slots.delete(worker)
    // exit 0 is a job well done; anything during our own shutdown is us
    if (!slot || stopping || (code === 0 && !signal)) {
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
