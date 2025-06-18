import { extractEnvs } from '@ozaco/std/io'
import { type LOGGER_LEVELS, createLogger } from '@ozaco/std/logger'
import { createFileTransport } from '@ozaco/std/logger-file'

export const ENV = extractEnvs(env => ({
  host: env.HOST as string,
  level: (env.LOG_LEVEL ?? 'log') as (typeof LOGGER_LEVELS)[number],
}))

export const logger = createLogger('example', ENV.level).use('file', createFileTransport())
