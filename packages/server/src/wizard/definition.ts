import { Broker, Gateway, isService } from 'server:core'
import { operation, useScope } from 'std:effect'
import type { Operation } from 'std:effect'
import { fail } from 'std:result'

import { WizardErrors } from './errors'
import type { FnRef, InstallWizardOptions, Wizard, WizardApi } from './types'
import { bridgeChangeBus } from './utils/bus'
import { createRealtimeRoute } from './utils/realtime'

const isResource = (value: unknown): value is Wizard.ResourceLike =>
  typeof value === 'object' && value !== null && '$wizard' in value

/**
 * Assemble the typed api tree — resources and classic services side by side. Pure identity at
 * runtime; its value is the type: `export type Api = typeof api` gives clients end-to-end types
 * without codegen.
 */
export const wizard = <const TTree extends WizardApi>(tree: TTree): TTree => tree

/**
 * Typed in-process call of a wizard fn from anywhere (other handlers included): a full broker
 * dispatch, so validation, access guards, policies and the trace spine all apply.
 *
 * ```ts
 * const doc = yield* run(api.tasks.complete, { id })
 * ```
 */
export const run = <TArgs, TResult>(ref: FnRef<TArgs, TResult>, args: TArgs): Operation<TResult> =>
  Broker.actions.call(ref.wizard.service, ref.wizard.key, args) as Operation<TResult>

/**
 * Register every service of the api tree on the broker and (by default) mount it on the gateway:
 * REST routes at `<prefix>/<key>` plus a `<prefix>/<key>/_realtime` WebSocket route for every
 * table-backed resource. Also bridges the db change bus over the broker unless disabled (or
 * unnecessary — see {@link bridgeChangeBus}).
 */
export const installWizard = operation(function* (api: WizardApi, options?: InstallWizardOptions) {
  const prefix = options?.prefix ?? ''
  const gateway = options?.gateway ?? true
  const scope = yield* useScope()

  for (const [key, entry] of Object.entries(api)) {
    const meta = isResource(entry) ? entry.$wizard : null
    const service = meta ? meta.service : entry

    if (!isService(service)) {
      throw fail(
        WizardErrors.BadDefinition,
        `wizard api entry "${key}" is neither a resource nor a service`,
      )
    }

    yield* Broker.actions.register(service)

    if (!gateway) {
      continue
    }

    yield* Gateway.actions.mount(`${prefix}/${key}`, service)

    if (meta?.table) {
      yield* Gateway.actions.socket(
        `${prefix}/${key}/_realtime`,
        createRealtimeRoute({ meta, scope }),
      )
    }
  }

  if (options?.bus ?? true) {
    yield* bridgeChangeBus()
  }
})
