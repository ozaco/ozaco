import type { AnyType, StandardSchemaV1 } from 'std:shared'
import { isFunction } from 'std:shared'

import { ACTION } from '../const'
import { withValidation } from '../internal/validation'
import type { Impl } from '../types/impl'

export const defineAction: Impl.DefineAction = (...args: AnyType[]) => {
  const [configOrHandler, maybeHandler] = args
  const hasConfig =
    typeof configOrHandler === 'object' && configOrHandler !== null && !isFunction(configOrHandler)

  const handler = hasConfig ? maybeHandler : configOrHandler
  const config = hasConfig ? configOrHandler : undefined

  const input = config?.input as StandardSchemaV1 | undefined
  const output = config?.output as StandardSchemaV1 | undefined

  const action = withValidation(handler, { input, output }) as AnyType

  Object.assign(action, {
    _t: ACTION,

    input,
    output,

    title: config?.title,
    description: config?.description,

    allow: config?.allow,
    deny: config?.deny,
    settings: config?.settings ?? [],
  })

  return action
}
