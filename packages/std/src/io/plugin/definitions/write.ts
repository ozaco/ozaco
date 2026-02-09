import { createDefinition } from 'std:plugin'
import { guard } from 'std:result'

import { IOErrors, Runtime } from '../../const'
import type { Impl } from '../../types'

export const writeDefinition = createDefinition((): Impl.Write => {
  return guard(
    async (_file, _view, _options) => {
      return 0
    },
    IOErrors.write,
    Runtime.unknown,
  )
}).key('write')
