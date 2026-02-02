import { createDefinition } from 'std:plugin'
import { guard } from 'std:result'
import { IOErrors, Runtime } from '../../const'
import type { Impl } from '../../types'
import type { FSError } from '../../utils'

export const exists = createDefinition((): Impl.Exists<FSError | IOErrors.exists> => {
  return guard(
    async _path => {
      return false as const
    },
    IOErrors.exists,
    Runtime.unknown,
  )
}).key('exists')
