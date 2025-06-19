import { homedir } from 'node:os'
import { join } from 'node:path'

import { createLogger } from '@ozaco/std/logger'
import { createFileTransport } from '@ozaco/std/logger-file'

export const logger = createLogger('tools/ls').use('file', createFileTransport(join(homedir(), '.ozaco/logs')))
