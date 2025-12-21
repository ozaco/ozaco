import { LEVEL } from 'src/logger/const'
import { optionsContext } from '../contexts'
import { unstyled } from './unstyled'

export const logDebug = unstyled.extend(({ def, use }) => {
  const ctx = use(optionsContext)

  const action = (...args: unknown[]) => {
    if (ctx.level <= LEVEL.DEBUG) {
      return
    }

    console.debug.apply(null, args)
  }

  return def.bind(null, action)
})
