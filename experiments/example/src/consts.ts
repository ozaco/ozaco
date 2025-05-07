import { extractEnvs } from '@ozaco/std/io'
import { createLogger } from '@ozaco/std/logger'
import { createFileTransport } from '@ozaco/std/logger-file'

export const ENV = extractEnvs(env => ({
  host: env.HOST,
}))

export const logger = createLogger({
  name: 'example',
  transports: [await createFileTransport()],
})
