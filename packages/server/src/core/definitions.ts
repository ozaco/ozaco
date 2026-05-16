import { defineProtocol } from 'std:plugin'

import { SERVER } from './const'
import type { Definitions } from './types/definitions'

export const Server = defineProtocol<
  Definitions.ServerContext,
  unknown,
  unknown[],
  Definitions.ServerActions
>({
  name: 'server',
  version: '0.0.1',
  subtype: SERVER,
})
