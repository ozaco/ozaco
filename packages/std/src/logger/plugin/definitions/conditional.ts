import { createDefinition, type Helpers } from 'std:plugin'
import { nop } from 'std:shared'

import { extendable } from '../extendable'

import { fakeLog } from './fake-log'
import type { init } from './init'
import type { unstyled } from './unstyled'

export const conditional = createDefinition(({ use }) => {
  return (contiditon: boolean) => {
    if (contiditon) {
      return use(extendable)
    }

    return {
      ...fakeLog,

      setOptions: nop as Helpers.InferDefinitionValue<typeof init>,
      unstyled: nop as Helpers.InferDefinitionValue<typeof unstyled>,
    }
  }
}).key('if')
