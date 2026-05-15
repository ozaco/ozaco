import { operation } from 'std:effect'
import type { AnyType } from 'std:shared'

import type { Hookable } from '../../types/hookable'

export const wrapAction = (action: Hookable.AnyAction, ...causes: string[]) =>
  operation(
    function* (...args: AnyType[]) {
      return yield* action(...args)
    },
    ...causes,
  )
