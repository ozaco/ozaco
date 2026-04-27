import { definePlugin } from 'std:plugin'
import type { AnyType } from 'std:shared'

import { SERVICE } from '../const'
import { SelfContext } from '../internal/contexts'
import type { Impl } from '../types/impl'

export const defineService: Impl.DefineService = options => {
  const { name, description, version, actions = {}, setup: rawSetup } = options

  const service: AnyType = definePlugin({
    name,
    description,
    version,

    setup: function* (...args: AnyType[]) {
      yield* SelfContext.set(service)

      if (rawSetup) {
        return yield* rawSetup(...(args as AnyType))
      }
    } as AnyType,
    subtype: SERVICE,
  }).build(actions as AnyType)

  return service
}
