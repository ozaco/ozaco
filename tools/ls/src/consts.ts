import { homedir } from 'node:os'
import { join } from 'node:path'

import { createLogger } from '@ozaco/std/logger'
import { createFileTransport } from '@ozaco/std/logger-file'

export const logger = createLogger({
  name: 'std/effects',
  transports: [
    createFileTransport({
      dir: join(homedir(), '.ozaco/logs'),
    }),
  ],
})
