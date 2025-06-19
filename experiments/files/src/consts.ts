import { extractEnvs } from '@ozaco/std/io'
import { createLogger, type LOGGER_LEVELS } from '@ozaco/std/logger'
import { createFileTransport } from '@ozaco/std/logger-file'

export const ENV = extractEnvs(env => ({
  level: (env.LOG_LEVEL ?? 'log') as (typeof LOGGER_LEVELS)[number],
}))

export const logger = createLogger('files', ENV.level).use('file', createFileTransport())
