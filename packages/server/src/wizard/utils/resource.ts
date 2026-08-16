import type { TableDef } from 'db:core'
import { defineService } from 'server:core'
import type { Action } from 'server:core'
import { fail } from 'std:result'
import type { AnyType } from 'std:shared'

import { WIZARD_FN } from '../const'
import { WizardErrors } from '../errors'
import { compileFn } from '../internal'
import type { ResourceOptions, Wizard, WizardFn } from '../types'

import { createRealtimeSseAction } from './realtime'

const isWizardFn = (value: unknown): value is WizardFn =>
  typeof value === 'object' && value !== null && (value as { _t?: unknown })._t === WIZARD_FN

/**
 * Compile a bag of wizard fns into a core `Service` (sugar, not a parallel world) and hand back
 * one typed `FnRef` per fn (for `run()`) plus the `$wizard` metadata `installWizard` mounts.
 *
 * Table-backed resources get a `/<name>/_realtime` socket route plus a compiled `realtime` action
 * (the `GET /_realtime/sse` SSE flavor — the fn key `realtime` is reserved); plain (name-only)
 * resources are REST/broker only.
 *
 * ```ts
 * const api = wizard({ tasks: resource(tasksTable, { ...crud(tasksTable), complete }) })
 * ```
 */
export function resource<const TFns extends Wizard.FnMap>(
  table: TableDef,
  fns: TFns,
  options?: ResourceOptions,
): Wizard.Resource<TFns>
export function resource<const TFns extends Wizard.FnMap>(
  name: string,
  fns: TFns,
): Wizard.Resource<TFns>
export function resource(
  base: TableDef | string,
  fns: Wizard.FnMap,
  options?: ResourceOptions,
): Wizard.Resource {
  const table = typeof base === 'string' ? null : base
  const name = typeof base === 'string' ? base : (options?.name ?? base.name)

  const actions: Record<string, Action<AnyType, AnyType>> = {}
  const watchable = new Map<string, Wizard.WatchRecipe>()

  for (const [key, fn] of Object.entries(fns)) {
    if (!isWizardFn(fn)) {
      throw fail(
        WizardErrors.BadDefinition,
        `resource "${name}" fn "${key}" is not a query/mutation/action declaration`,
      )
    }

    actions[key] = compileFn(key, fn)

    if (table && fn.watch && fn.kind === 'query') {
      watchable.set(
        key,
        fn.pipeline
          ? { kind: 'list', pipeline: fn.pipeline, access: fn.access }
          : { kind: 'custom', access: fn.access },
      )
    }
  }

  if (table) {
    if (actions['realtime']) {
      throw fail(
        WizardErrors.BadDefinition,
        `resource "${name}" fn key "realtime" is reserved for the SSE realtime action`,
      )
    }

    actions['realtime'] = createRealtimeSseAction({ name, table, watchable })
  }

  const service = defineService({ name, version: '0.1.0', actions })
  const meta: Wizard.ResourceMeta = { name, table, service, watchable }
  const refs: Record<string, unknown> = { $wizard: meta }

  for (const [key, compiled] of Object.entries(actions)) {
    refs[key] = Object.assign(compiled, { wizard: { service: name, key } })
  }

  return refs as AnyType as Wizard.Resource
}
