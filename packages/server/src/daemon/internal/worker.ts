import { until } from 'std:effect'
import { fail } from 'std:result'
import type { AnyType } from 'std:shared'

import { DaemonErrors } from '../const'
import type { DaemonDef } from '../types'

import type { ResolvedFailure } from './failure'

export const spawnWorkers = function* (replicate: DaemonDef.Replicate, failure: ResolvedFailure) {
  const script = replicate.script
  if (script === undefined) {
    return yield* fail(DaemonErrors.MissingScript, 'worker strategy requires replicate.script')
  }

  const wt = (yield* until(import('node:worker_threads'))) as AnyType
  const Worker = wt.Worker as AnyType
  const os = (yield* until(import('node:os'))) as AnyType

  const base: { role: string | null }[] = replicate.roles
    ? Object.entries(replicate.roles).flatMap(([role, count]) =>
        Array.from({ length: count }, () => ({ role })),
      )
    : Array.from({ length: replicate.count ?? os.cpus().length }, () => ({ role: null }))
  const specs = base.map((spec, index) => ({ role: spec.role, index }))

  const live = new Set<AnyType>()

  const teardown = () => {
    for (const worker of live) {
      worker?.terminate?.()
    }
    // oxlint-disable-next-line no-process-exit
    process.exit(1)
  }

  const spawn = (spec: { role: string | null; index: number }, runs: number): AnyType => {
    const worker = new Worker(script, {
      workerData: { role: spec.role, index: spec.index },
    }) as AnyType
    live.add(worker)
    // an unhandled 'error' would crash the primary; supervision happens in the 'exit' handler
    worker.on('error', () => {})
    worker.on('exit', (code: number) => {
      live.delete(worker)
      if (code === 0) {
        return
      }
      if (runs < failure.retry.attempts) {
        const { delay, backoff, maxDelay } = failure.retry
        const wait = Math.min(delay * backoff ** (runs - 1), maxDelay)
        const respawn = () => spawn(spec, runs + 1)
        if (wait > 0) {
          setTimeout(respawn, wait)
        } else {
          respawn()
        }
        return
      }
      if (failure.mode === 'all') {
        teardown()
      }
    })
    return worker
  }

  return specs.map(spec => spawn(spec, 1))
}
