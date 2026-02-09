import { fileURLToPath } from 'node:url'
import { createDefinition } from 'std:plugin'
import { guard } from 'std:result'
import { isString } from 'std:shared'
import { FILE, Flags, IOErrors, Runtime } from '../../const'
import type { Api, Impl } from '../../types'
import { handle as handleDefinition } from './handle'
import { stats as statsDefinition } from './stats'

export const open = createDefinition(({ use }): Impl.Open => {
  const handleApi = use(handleDefinition)
  const statsApi = use(statsDefinition)

  return guard(
    async function* (rawHandle, flag = Flags.none) {
      const resolvedHandle = rawHandle instanceof URL ? fileURLToPath(rawHandle) : rawHandle
      const handle = isString(resolvedHandle) ? handleApi(resolvedHandle) : resolvedHandle
      const stats = yield* await statsApi.stats(handle)

      return {
        _t: FILE,

        raw: null,

        handle,
        stats,
        flag,

        [Symbol.dispose]: () => {},
        [Symbol.asyncDispose]: async () => {},
      } satisfies Api.File
    },
    IOErrors.open,
    Runtime.unknown,
  )
}).key('open')
