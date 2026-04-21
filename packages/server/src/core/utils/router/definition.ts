import { defineProtocol } from 'std:plugin'

import { ROUTER } from '../../const'
import type { RouterActions, RouterContext } from '../../types/router'

export const Router = defineProtocol<RouterContext, unknown, [], RouterActions>({
  name: 'router',
  version: '0.0.1',
  subtype: ROUTER,
})
