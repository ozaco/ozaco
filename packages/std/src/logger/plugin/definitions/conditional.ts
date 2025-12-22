import { createDefinition, type Helpers } from 'std:plugin'

import { partialExtendable } from '../extendable'

import type { logDebug } from './debug'
import type { init } from './init'
import type { unstyled } from './unstyled'

export const conditional = createDefinition(({ use }) => {
  const nop = (..._args: unknown[]) => void 0

  return (contiditon: boolean) => {
    if (contiditon) {
      return use(partialExtendable)
    }

    return {
      debug: nop as Helpers.InferDefinitionValue<typeof logDebug>,
      setOptions: nop as Helpers.InferDefinitionValue<typeof init>,
      unstyled: nop as Helpers.InferDefinitionValue<typeof unstyled>,
    }
  }
})
