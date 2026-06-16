import { until } from 'std:effect'
import { IO } from 'std:io'
import type { AnyType } from 'std:shared'

import { DAEMON_ENV } from '../const'
import type { DaemonDef } from '../types'

interface WorkerData {
  role?: string | null
  index?: number
}

const splitRoles = (value: string | undefined | null): string[] =>
  (value ?? '')
    .split(',')
    .map(role => role.trim())
    .filter(Boolean)

export const resolveRuntime = function* (options: DaemonDef.Options) {
  const env = yield* IO.actions.env(data => ({ ...data }))
  const replicate = options.replicate

  const strategy: DaemonDef.Strategy =
    (env[DAEMON_ENV.strategy] as DaemonDef.Strategy) || replicate?.strategy || 'none'
  const mode: DaemonDef.Mode =
    (env[DAEMON_ENV.mode] as DaemonDef.Mode) || replicate?.mode || 'shared-port'

  let primary = true
  let index = -1
  let workerData: WorkerData = {}

  if (strategy === 'cluster') {
    const mod = (yield* until(import('node:cluster'))) as AnyType
    const cluster = (mod.default ?? mod) as AnyType
    primary = Boolean(cluster.isPrimary)
    index = cluster.worker?.id ?? -1
  } else if (strategy === 'worker') {
    const wt = (yield* until(import('node:worker_threads'))) as AnyType
    primary = Boolean(wt.isMainThread)
    index = wt.isMainThread ? -1 : (wt.threadId ?? -1)
    workerData = (wt.workerData ?? {}) as WorkerData
  }

  const roles = new Set(
    splitRoles(workerData.role ?? env[DAEMON_ENV.role] ?? env[DAEMON_ENV.service]),
  )

  const rt: DaemonDef.Runtime = {
    env,
    roles,
    runsAll: roles.size === 0,
    role: roles.size > 0 ? [...roles][0]! : null,
    index: workerData.index ?? index,
    strategy,
    mode: strategy === 'none' ? null : mode,
    primary,
    supervisor: primary && strategy !== 'none',
    reusePort: strategy === 'cluster' && mode === 'shared-port',
  }

  return rt
}
