import { createDefinition, type Helpers } from 'std:plugin'
import { logDebug } from './debug'
import { init } from './init'
import { unstyled } from './unstyled'

export const conditional = createDefinition(({ use }) => {
  const logger = {
    debug: use(logDebug),
    setOptions: use(init),
    unstyled: use(unstyled),
  }

  const nop = (..._args: unknown[]) => void 0

  return (contiditon: boolean) => {
    if (contiditon) {
      return logger
    }

    return {
      debug: nop as Helpers.InferDefinitionValue<typeof logDebug>,
      setOptions: nop as Helpers.InferDefinitionValue<typeof init>,
      unstyled: nop as Helpers.InferDefinitionValue<typeof unstyled>,
    }
  }
})
