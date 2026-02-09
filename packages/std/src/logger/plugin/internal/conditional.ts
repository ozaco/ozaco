import { createDefinition, type Helpers } from 'std:plugin'
import { nop } from 'std:shared'

import { extendable } from '../extendable'

import { fakeLog } from './fake-log'
import type { initImplementation } from './init'
import type { unstyledImplementation } from './unstyled'

export const conditionalImplementation = createDefinition(({ use }) => {
  return (contiditon: boolean) => {
    if (contiditon) {
      return use(extendable)
    }

    return {
      ...fakeLog,

      setOptions: nop as Helpers.InferDefinitionValue<typeof initImplementation>,
      unstyled: nop as Helpers.InferDefinitionValue<typeof unstyledImplementation>,
    }
  }
}).key('if')
