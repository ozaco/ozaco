import { operation } from 'std:effect'
import type { AnyType } from 'std:shared'

import { ACTION } from '../const'
import { runSchema } from '../internal/validation'
import type { Action, ActionConfig, ActionFrom, ActionHandler, ActionMeta } from '../types/action'
import type { Params, Returns } from '../types/channel'

import { manifestOf, normalizeDeclaration, valueSchemaOf } from './channel'

/**
 * Defines a typed action: input/output declarations resolve ONCE into the wire manifest; the
 * callable runs input validation → handler → output validation. Route, policies, disconnect
 * behavior and error statuses are TYPED fields (there is no settings bag).
 *
 * ```ts
 * const get = defineAction(
 *   {
 *     input: z.object({ id: z.string() }),
 *     output: Todo,
 *     route: { method: 'GET', path: '/:id' },
 *     policies: { cache: { ttl: 5_000 }, retry: false },
 *     errors: { 'todos.not-found': 404 },
 *   },
 *   function* (body) { ... },
 * )
 * ```
 */
export function defineAction<const C extends ActionConfig>(
  config: C,
  handler: ActionHandler<Params<C['input']>, Returns<C['output']>>,
): ActionFrom<C>
export function defineAction<TParams = undefined, TResult = unknown>(
  handler: ActionHandler<TParams, TResult>,
): Action<TParams, TResult>
export function defineAction(
  configOrHandler: ActionConfig | ActionHandler<AnyType, unknown>,
  maybeHandler?: ActionHandler<AnyType, unknown>,
): Action<AnyType, unknown> {
  const config = (maybeHandler ? configOrHandler : {}) as ActionConfig
  const handler = (maybeHandler ?? configOrHandler) as ActionHandler<AnyType, unknown>

  const input = normalizeDeclaration(config.input)
  const output = normalizeDeclaration(config.output)
  const wire = manifestOf(input, output)

  const meta: ActionMeta = {
    title: config.title,
    description: config.description,
    input: config.input,
    output: config.output,
    wire,
    route: config.route,
    kind: config.kind,
    policies: config.policies ?? {},
    onDisconnect: config.onDisconnect ?? 'cancel',
    outcome: config.outcome ?? false,
    errors: config.errors ?? {},
    docs: config.docs,
  }

  const inputSchema = valueSchemaOf(input)
  const outputSchema = wire.streamingOut ? undefined : valueSchemaOf(output)

  const callable = operation(function* (params: unknown) {
    const checked = inputSchema ? yield* runSchema(inputSchema, params, 'input') : params
    const result = yield* handler(checked)

    return outputSchema ? yield* runSchema(outputSchema, result, 'output') : result
  })

  return Object.assign(callable, { _t: ACTION, meta }) as Action<AnyType, unknown>
}
