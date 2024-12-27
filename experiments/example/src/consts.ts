import { extractEnvs } from '@ozaco/std/io'
import { create } from '@ozaco/std/logger'
import { createFileTransport } from '@ozaco/std/logger-file'

export const ENV = extractEnvs(env => ({
  host: env.HOST,
}))

export const logger = create({
  name: 'example',
  transports: [createFileTransport()],
})
