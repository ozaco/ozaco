import { Broker, CoreErrors, Gateway } from 'server:core'
import type { GatewayInfo } from 'server:core'
import { moduleLogger } from 'server:utils'
import type { BoundLogger } from 'server:utils'
import { attempt, operation } from 'std:effect'
import { definePlugin } from 'std:plugin'
import { fail, isFailure } from 'std:result'

import type { DaemonInfo, DaemonModule, DaemonOptions, DaemonRuntime } from './types'

const GATEWAY_ROLE = 'gateway'

interface DaemonCtx {
  readonly options: DaemonOptions
  readonly log: BoundLogger
}

const resolveRuntime = (options: DaemonOptions): DaemonRuntime => {
  const env = options.env ?? (process.env as Record<string, string | undefined>)
  const role = env['SERVICE']

  if (!role) {
    return { kind: 'monolith', env }
  }

  if (role === GATEWAY_ROLE) {
    return { kind: 'gateway', env }
  }

  return { kind: 'service', service: role, env }
}

/**
 * Topology bootstrap — the SAME app file runs every deployment shape:
 * - no `SERVICE` env → monolith: register + mount everything, start the gateway;
 * - `SERVICE=gateway` → edge only: mount every module, own none (dispatch rides the transports);
 * - `SERVICE=<name>` → headless owner: register that module only, no edge.
 */
const definition = definePlugin<DaemonCtx, [DaemonOptions]>({
  name: 'server/daemon',
  version: '0.1.0',
  *setup(options: DaemonOptions) {
    if (options.modules.length === 0) {
      return yield* fail(CoreErrors.Configuration, 'the daemon needs at least one module')
    }

    const log = yield* moduleLogger('server:daemon')

    return { options, log }
  },
})

/** @see module doc */
export const Daemon = definition.build({
  start: operation(function* () {
    const { options, log } = yield* definition.context.expect()
    const runtime = resolveRuntime(options)

    if (
      runtime.kind === 'service' &&
      !options.modules.some(module => module.name === runtime.service)
    ) {
      const known = options.modules.map(module => module.name).join(', ')

      return yield* fail(
        CoreErrors.Configuration,
        `SERVICE="${runtime.service}" does not match any module (known: ${known})`,
      )
    }

    yield* log.info('daemon starting', { kind: runtime.kind, service: runtime.service })

    if (options.base) {
      yield* options.base(runtime)
    }

    const active = options.modules.filter(module => !module.when || module.when(runtime))
    const owned: DaemonModule[] = []
    const mounted: DaemonModule[] = []

    for (const module of active) {
      const owns = runtime.kind === 'monolith' || runtime.service === module.name

      if (owns) {
        if (module.setup) {
          yield* module.setup(runtime)
        }

        yield* Broker.actions.register(module.service)
        owned.push(module)
      }

      if (runtime.kind !== 'service') {
        const prefix = module.prefix ?? `/${module.name}`
        const attempted = yield* attempt(() => Gateway.actions.mount(prefix, module.service))

        if (isFailure(attempted)) {
          // no gateway engine installed — a headless monolith is a legal shape
          yield* log.debug('mount skipped', { module: module.name, error: String(attempted.error) })
        } else {
          mounted.push(module)
        }
      }
    }

    yield* Broker.actions.start()

    let gateway: GatewayInfo | undefined

    if (runtime.kind !== 'service' && mounted.length > 0) {
      const started = yield* attempt(() => Gateway.actions.start(options.serve))

      if (isFailure(started)) {
        return yield* fail(
          CoreErrors.Configuration,
          'gateway start failed — install a gateway adapter (bun/node/deno) in base()',
          ...started.causes,
        )
      }

      gateway = started.value
    }

    if (options.ready) {
      yield* options.ready(runtime, mounted)
    }

    const info: DaemonInfo = {
      runtime,
      owned: owned.map(module => module.name),
      mounted: mounted.map(module => module.name),
      gateway,
    }

    yield* log.info('daemon started', {
      kind: runtime.kind,
      owned: info.owned.join(','),
      mounted: info.mounted.join(','),
      url: gateway?.url,
    })

    return info
  }),

  stop: operation(function* () {
    const { log } = yield* definition.context.expect()

    yield* attempt(() => Gateway.actions.stop())
    yield* attempt(() => Broker.actions.destroy())
    yield* log.info('daemon stopped', {})
  }),
})
