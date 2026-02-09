import { createDefinition } from 'std:plugin'
import { guard } from 'std:result'

import { IOErrors, Runtime } from '../../const'
import type { Impl } from '../../types'

export const readDefinition = createDefinition((): Impl.Read => {
  return guard(
    async (_file, _view, _options) => {
      return 0
    },
    IOErrors.read,
    Runtime.unknown,
  )
}).key('read')
