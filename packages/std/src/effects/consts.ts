import { extractEnvs } from '../io'
import { createLogger } from '../logger'

export const ENV = extractEnvs(env => ({
  handler: env.STD_HANDLER ? env.STD_HANDLER === 'true' : typeof window === 'undefined',
}))

export const logger = createLogger('std/effects')
