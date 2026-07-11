import type { Operation } from 'std:effect'
import { operation } from 'std:effect'
import { fail } from 'std:result'
import type { AnyType } from 'std:shared'

import { RAW_ACTION } from '../const'
import type { Hookable } from '../types/hookable'

export const getService = operation(function* (
  handler: (...args: AnyType[]) => Operation<AnyType>,
) {
  try {
    return (yield* (handler as (...args: AnyType[]) => Operation<unknown>)(
      RAW_ACTION,
    )) as Hookable.RawAction
  } catch {
    return yield* fail('unexpected', "handler isn't part of a plugin")
  }
})
