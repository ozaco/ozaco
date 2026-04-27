import { operation } from 'std:effect'
import type { AnyType, StandardSchemaV1 } from 'std:shared'
import { isFunction } from 'std:shared'

import { ACTION, ACTION_CONTEXT } from '../const'
import { ActionContextRef } from '../internal/contexts'
import { withValidation } from '../internal/validation'
import type { Impl } from '../types/impl'

const withAmbientContext = (handler: AnyType) =>
  operation(function* (...callArgs: AnyType[]) {
    const ctx = callArgs[0]
    if (ctx && ctx._t === ACTION_CONTEXT) {
      return yield* ActionContextRef.with(ctx, function* () {
        return yield* handler(...callArgs)
      })
    }
    return yield* handler(...callArgs)
  })

export const defineAction: Impl.DefineAction = (...args: AnyType[]) => {
  const [configOrHandler, maybeHandler] = args
  const hasConfig =
    typeof configOrHandler === 'object' && configOrHandler !== null && !isFunction(configOrHandler)

  const handler = hasConfig ? maybeHandler : configOrHandler
  const config = hasConfig ? configOrHandler : undefined

  const inputSchema = config?.input as StandardSchemaV1 | undefined
  const outputSchema = config?.output as StandardSchemaV1 | undefined

  const action = withAmbientContext(
    inputSchema || outputSchema
      ? withValidation(handler, { input: inputSchema, output: outputSchema })
      : handler,
  )

  Object.assign(action, {
    _t: ACTION,
    _r: !hasConfig,

    input: inputSchema,
    output: outputSchema,

    title: config?.title,
    description: config?.description,

    allow: config?.allow,
    deny: config?.deny,
    settings: config?.settings,
  })

  return action as AnyType
}
