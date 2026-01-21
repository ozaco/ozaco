import { createDefinition } from 'std:plugin'
import { guard } from 'std:result'
import { isString } from 'std:shared'

import { FILE, IOErrors, Runtime } from '../../const'
import type { Api, Impl } from '../../type'

import { handle as handleDefinition } from './handle'
import { stats as statsDefinition } from './stats'

export const open = createDefinition(({ use }): Impl.Open => {
  const handleApi = use(handleDefinition)
  const statsApi = use(statsDefinition)

  return guard(
    async function* (rawHandle) {
      const handle = isString(rawHandle) ? handleApi(rawHandle) : rawHandle
      const stats = yield* await statsApi.stats(handle)

      return {
        _t: FILE,

        raw: null,
        handle,
        stats,

        [Symbol.dispose]: () => {},
        [Symbol.asyncDispose]: async () => {},
      } satisfies Api.File
    },
    IOErrors.open,
    Runtime.unknown,
  )
}).key('open')
