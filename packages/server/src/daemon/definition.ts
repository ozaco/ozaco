import { Broker, Gateway } from 'server:core'
import { attempt, operation, retry, useContext } from 'std:effect'
import { Logger } from 'std:logger'
import { definePlugin } from 'std:plugin'
import { appendCauses, isSuccess } from 'std:result'

import { DAEMON_ENV } from './const'
import { forkCluster } from './internal/cluster'
import { DaemonCtxRef } from './internal/contexts'
import { resolveFailure } from './internal/failure'
import { resolveRuntime } from './internal/runtime'
import { spawnWorkers } from './internal/worker'
import type { DaemonDef } from './types'

const eligible = (module: DaemonDef.Module, rt: DaemonDef.Runtime): boolean => {
  const roleOk =
    rt.runsAll || module.roles === undefined || module.roles.some(role => rt.roles.has(role))
  const whenOk = module.when === undefined || module.when(rt)
  return roleOk && whenOk
}

export const Daemon = definePlugin({
  name: 'server/daemon',
  version: '0.0.0',
  description: 'bootstrap + cluster/worker replication',

  *setup(options: DaemonDef.Options) {
    const ctx: DaemonDef.Context = { options }
    yield* DaemonCtxRef.set(ctx)
    return ctx
  },
}).build({
  start: operation(function* () {
    const { options } = yield* useContext(DaemonCtxRef)
    const rt = yield* resolveRuntime(options)

    if (rt.supervisor) {
      const base = options.replicate ?? { strategy: rt.strategy }
      // DAEMON_COUNT overrides the configured count (shared-port / worker pool size).
      const envCount = Number(rt.env[DAEMON_ENV.count])
      const replicate =
        Number.isFinite(envCount) && envCount > 0 ? { ...base, count: envCount } : base

      // Crashed replicas are restarted / torn down per the daemon-level failure policy.
      const failure = resolveFailure(undefined, options.failure)
      if (rt.strategy === 'cluster') {
        yield* forkCluster(replicate, rt.mode ?? 'shared-port', failure)
      } else if (rt.strategy === 'worker') {
        yield* spawnWorkers(replicate, failure)
      }
      return rt
    }

    const outcome = yield* attempt(
      (function* () {
        if (options.base) {
          yield* options.base(rt)
        }

        for (const module of options.modules) {
          if (!eligible(module, rt)) {
            continue
          }

          const policy = resolveFailure(module.failure, options.failure)
          const result = yield* attempt(
            policy.retry.attempts > 1
              ? retry(() => module.setup(rt), policy.retry)
              : () => module.setup(rt),
          )

          if (!isSuccess(result)) {
            const failed = appendCauses(result, `daemon:module=${module.name}`)
            // `isolate`: drop just this module and keep assembling the rest. `all`: abort the replica.
            if (policy.mode === 'isolate') {
              if ((yield* Logger.context.get()) !== undefined) {
                yield* Logger.actions.error(
                  `daemon: module "${module.name}" isolated after failure (role ${rt.role ?? 'all'}): ${failed.message || String(failed.error)}`,
                )
              }
              continue
            }
            return yield* failed
          }
        }

        yield* Broker.actions.start()

        // Start the gateway only if `base` installed one. shared-port replicas bind SO_REUSEPORT.
        if ((yield* Gateway.context.get()) !== undefined) {
          yield* Gateway.actions.start(rt.reusePort ? { reusePort: true } : {})
        }

        if (options.ready) {
          yield* options.ready(rt)
        }
      })(),
    )

    if (!isSuccess(outcome)) {
      return yield* appendCauses(outcome, `daemon:role=${rt.role ?? 'all'} index=${rt.index}`)
    }

    return rt
  }),
})
