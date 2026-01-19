import { createDefinition } from 'std:plugin'
import { guard } from 'std:result'

import { IOErrors, Runtime } from '../../const'
import type { Impl } from '../../type'

import { stats as statsDefinition } from './stats'

export const open = createDefinition(({ use }): Impl.Open => {
  const statsApi = use(statsDefinition)

  return guard(
    async function* (handle) {
      const stats = yield* await statsApi.stats(handle)

      return {
        raw: null,
        handle,
        stats,

        [Symbol.dispose]: () => {},
        [Symbol.asyncDispose]: async () => {},
      }
    },
    IOErrors.open,
    Runtime.unknown,
  )
}).key('open')
