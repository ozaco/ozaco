import { operation } from 'std:effect'
import type { AnyType } from 'std:shared'

import type { Helpers } from '../../types/helpers'

export const wrapAction = (action: Helpers.AnyAction, ...causes: string[]) =>
  operation(
    function* (...args: AnyType[]) {
      return yield* action(...args)
    },
    ...causes,
  )
