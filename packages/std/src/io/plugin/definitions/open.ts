import { createDefinition } from 'std:plugin'
import { guard } from 'std:result'

import { FILE, Flags, IOErrors, Runtime } from '../../const'
import type { Api, Impl } from '../../types'
import { ioContext } from '../base'
import { handleDefinition } from './handle'
import { statsDefinition } from './stats'

export const openDefinition = createDefinition(({ use }): Impl.Open => {
  const handleApi = use(handleDefinition)
  const statsApi = use(statsDefinition)
  const context = use(ioContext)

  return guard(
    async function* (target, rawFlag) {
      const flag = context.autoPerm ? (rawFlag ?? Flags.Moderator) : (rawFlag ?? Flags.none)

      const handle = handleApi(target)
      const stats = yield* await statsApi.stats(handle)

      return {
        _t: FILE,

        meta: {},

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
