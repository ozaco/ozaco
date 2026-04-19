import { defineNamespace } from 'std:plugin'

import { SERVER } from '../const'
import type { ServerActions, ServerContext } from '../types/server'

export const Server = defineNamespace<ServerContext, unknown, [], ServerActions>({
  name: 'server',
  version: '0.0.1',
  subtype: SERVER,
})
