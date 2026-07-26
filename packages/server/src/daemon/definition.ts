import type { Service } from 'server:core'
import { Broker, Gateway, RoleContext } from 'server:core'
import { attempt, operation, retry, useContext } from 'std:effect'
import { Logger } from 'std:logger'
import { definePlugin } from 'std:plugin'
import { appendCauses, isSuccess } from 'std:result'

import { assembleModule } from './internal/assemble'
import { forkCluster } from './internal/cluster'
import { DaemonCtxRef } from './internal/contexts'
import { resolveFailure } from './internal/failure'
import { owns, ownsRole, serves, servesRole } from './internal/role'
import { resolveRuntime } from './internal/runtime'
import type { DaemonDef } from './types'

export const Daemon = definePlugin({
  name: 'server/daemon',
  version: '0.0.0',
  description: 'env-resolved bootstrap: monolith, gateway, or one service',

  *setup(options: DaemonDef.Options) {
    const ctx: DaemonDef.Context = { options, runtime: null }
    yield* DaemonCtxRef.set(ctx)

    // Publish how this process was deployed, so a self-wiring service (`install(svc, { mount })`, a
    // wizard resource) resolves its own role without being told. The closure reads `ctx.runtime`,
    // which `start()` fills in before anything is wired.
    yield* RoleContext.set({
      owns: name => ctx.runtime === null || ownsRole(name, ctx.runtime),
      serves: () => ctx.runtime === null || servesRole(ctx.runtime),
      managed: service => options.modules.some(module => module.service === service),
    })

    return ctx
  },
}).build({
  start: operation(function* () {
    const ctx = yield* useContext(DaemonCtxRef)
    const options = ctx.options
    const rt = yield* resolveRuntime(options)

    // publish the identity before anything is wired: `base` and every module setup run below, and a
    // self-configuring plugin (a wizard resource) reads it from here rather than being told
    ctx.runtime = rt

    // The cluster primary forks one child per module and then carries on as the gateway below.
    if (rt.cluster && rt.kind === 'gateway') {
      yield* forkCluster(options.modules, rt, resolveFailure(undefined, options.failure))
    }

    const outcome = yield* attempt(function* () {
      if (options.base) {
        yield* options.base(rt)
      }

      // services whose routes THIS process exposed — handed to `ready` so the gateway can document
      // the full surface without owning any of it
      const mounted: Service[] = []

      for (const module of options.modules) {
        const owned = owns(module, rt)
        const served = serves(module, rt)

        if (!owned && !served) {
          continue
        }

        const unit = () => assembleModule(module, rt, { owned, served, mounted })
        const policy = resolveFailure(module.failure, options.failure)
        const result = yield* attempt(policy.retry.attempts > 1 ? retry(unit, policy.retry) : unit)

        if (!isSuccess(result)) {
          const failed = appendCauses(result, `daemon:module=${module.name}`)
          // `isolate`: drop just this module and keep assembling the rest. `all`: abort the process.
          if (policy.mode === 'isolate') {
            if ((yield* Logger.context.get()) !== undefined) {
              yield* Logger.actions.error(
                `daemon: module "${module.name}" isolated after failure (${rt.kind}): ${failed.message || String(failed.error)}`,
              )
            }
            continue
          }
          return yield* failed
        }
      }

      yield* Broker.actions.start()

      // Start the gateway only if `base` installed one — a service process is headless.
      if ((yield* Gateway.context.get()) !== undefined) {
        yield* Gateway.actions.start({})
      }

      if (options.ready) {
        yield* options.ready(rt, mounted)
      }
    })

    if (!isSuccess(outcome)) {
      return yield* appendCauses(outcome, `daemon:kind=${rt.kind} service=${rt.service ?? '-'}`)
    }

    return rt
  }),
})
