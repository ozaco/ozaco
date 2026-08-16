import type { Params, Schema } from 'server:core'

import { WIZARD_FN } from '../const'
import type { Wizard, WizardFn } from '../types'

/**
 * Declare a read fn (kind `query`). Handlers are hook-style — no ctx parameter: reach the world
 * with `useDb`/`useRequest`/`useLog`/... inside. `watch: true` additionally makes it
 * realtime-watchable (re-run on table changes; `sync` frames carry `rows: [value]`).
 *
 * ```ts
 * const stats = query({
 *   watch: true,
 *   *handler() {
 *     const db = yield* useDb(tasks)
 *     return { open: yield* db.query('tasks').where({ done: false }).count() }
 *   },
 * })
 * ```
 */
export const query = <TArgs extends Schema | undefined = undefined, TResult = unknown>(
  config: Wizard.QueryConfig<TArgs, TResult>,
): WizardFn<Params<TArgs>, TResult> => ({
  _t: WIZARD_FN,
  kind: 'query',
  watch: config.watch ?? false,
  args: config.args,
  returns: config.returns,
  access: config.access,
  rest: config.rest,
  policies: config.policies,
  errors: config.errors,
  docs: config.docs,
  handler: config.handler,
})

/** Declare a write fn (kind `mutation`). */
export const mutation = <TArgs extends Schema | undefined = undefined, TResult = unknown>(
  config: Wizard.MutationConfig<TArgs, TResult>,
): WizardFn<Params<TArgs>, TResult> => ({
  _t: WIZARD_FN,
  kind: 'mutation',
  watch: false,
  args: config.args,
  returns: config.returns,
  access: config.access,
  rest: config.rest,
  policies: config.policies,
  errors: config.errors,
  docs: config.docs,
  handler: config.handler,
})

/** Declare a general side-effect fn (kind `action`) — supports `onDisconnect` and `outcome`. */
export const action = <TArgs extends Schema | undefined = undefined, TResult = unknown>(
  config: Wizard.ActionFnConfig<TArgs, TResult>,
): WizardFn<Params<TArgs>, TResult> => ({
  _t: WIZARD_FN,
  kind: 'action',
  watch: false,
  onDisconnect: config.onDisconnect,
  outcome: config.outcome,
  args: config.args,
  returns: config.returns,
  access: config.access,
  rest: config.rest,
  policies: config.policies,
  errors: config.errors,
  docs: config.docs,
  handler: config.handler,
})
