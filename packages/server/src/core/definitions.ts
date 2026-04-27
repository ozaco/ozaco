import { operation } from 'std:effect'
import { defineProtocol } from 'std:plugin'

import { REST_TRANSFORMER, ROUTER, SERVER, WS_TRANSFORMER } from './const'
import type { RestTransformerActions, RestTransformerContext } from './types/rest'
import type { RouterActions, RouterContext } from './types/router'
import type { ServerActions, ServerContext } from './types/server'
import type { WsTransformerActions, WsTransformerContext } from './types/ws'

export const Server = defineProtocol<ServerContext, unknown, unknown[], ServerActions>({
  name: 'server',
  version: '0.0.1',
  subtype: SERVER,
})

export const Router = defineProtocol<RouterContext, unknown, [], RouterActions>({
  name: 'router',
  version: '0.0.1',
  subtype: ROUTER,
})

export const RestTransformer = defineProtocol<
  RestTransformerContext,
  unknown,
  [options?: RestTransformerContext],
  RestTransformerActions
>({
  name: 'rest-transformer',
  version: '0.0.1',
  subtype: REST_TRANSFORMER,
})

export const WsTransformer = defineProtocol<
  WsTransformerContext,
  unknown,
  [options?: WsTransformerContext],
  WsTransformerActions
>({
  name: 'ws-transformer',
  version: '0.0.1',
  subtype: WS_TRANSFORMER,

  defaultActions: {
    // oxlint-disable-next-line require-yield
    upgrade: operation(function* () {
      return false
    }),
  },
})
