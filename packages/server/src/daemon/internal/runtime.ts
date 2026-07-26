import { until } from 'std:effect'
import { IO } from 'std:io'
import type { AnyType } from 'std:shared'

import { DAEMON_ENV, GATEWAY_ROLE } from '../const'
import type { DaemonDef } from '../types'

/**
 * Work out what this process is. Everything comes from the environment plus, under `cluster`, whether
 * node:cluster considers us the primary — so the same entry file resolves a different identity in
 * every pod (or every fork) without any per-process configuration.
 */
export const resolveRuntime = function* (options: DaemonDef.Options) {
  const env = yield* IO.actions.env(data => ({ ...data }))
  const cluster = options.cluster ?? false

  let primary = true
  let index = -1

  if (cluster) {
    const mod = (yield* until(import('node:cluster'))) as AnyType
    const node = (mod.default ?? mod) as AnyType
    primary = Boolean(node.isPrimary)
    index = node.worker?.id ?? -1
  }

  // the environment ALWAYS beats the option: every fork and every pod runs this same entry, and
  // its identity must be assignable from OUTSIDE the shared code — see Options.service
  const named = env[DAEMON_ENV.service]?.trim() || options.service?.trim() || null

  // The cluster primary is always the gateway: its children own the services (it forks one per
  // module), so it must not own them too.
  const kind: DaemonDef.Kind =
    cluster && primary
      ? 'gateway'
      : named === null
        ? 'monolith'
        : named === GATEWAY_ROLE
          ? 'gateway'
          : 'service'

  const rt: DaemonDef.Runtime = {
    env,
    kind,
    service: kind === 'service' ? named : null,
    index,
    cluster,
  }

  return rt
}
