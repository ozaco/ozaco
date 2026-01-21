import { createDefinition } from 'std:plugin'
import { guard } from 'std:result'
import { IOErrors, Runtime } from 'src/io/const'
import type { Impl } from '../../type'

export const write = createDefinition((): Impl.Write => {
  return guard(
    async (_rawFile, _view, _options) => {
      return 0
    },
    IOErrors.write,
    Runtime.unknown,
  )
}).key('write')
