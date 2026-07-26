import type { AnyType } from 'std:shared'
import { isFunction } from 'std:shared'

import { ACTION } from '../const'
import { withValidation } from '../internal/validation'
import { resolveWire } from '../internal/wire'
import type { Action } from '../types/action'
import type { Impl } from '../types/impl'

export const defineAction: Impl.DefineAction = (...args: AnyType[]) => {
  const [configOrHandler, maybeHandler] = args
  const hasConfig =
    typeof configOrHandler === 'object' && configOrHandler !== null && !isFunction(configOrHandler)

  const handler = hasConfig ? maybeHandler : configOrHandler
  const config = hasConfig ? configOrHandler : undefined

  // Resolved ONCE, here, where the declaration is still in front of us. Everything downstream reads
  // `wire` and never re-derives it — that is what stops a carrier from asking a value what it is.
  const wire = resolveWire(config?.input, config?.output)

  const action = withValidation(handler, wire) as unknown as Action

  Object.assign(action, {
    _t: ACTION,

    ...(config?.input === undefined ? {} : { input: config.input }),
    ...(config?.output === undefined ? {} : { output: config.output }),
    ...(config?.title === undefined ? {} : { title: config.title }),
    ...(config?.description === undefined ? {} : { description: config.description }),

    wire,
    settings: config?.settings ?? [],
  })

  return action
}
