import { operation } from 'std:effect'
import { defineProtocol } from 'std:plugin'
import type { AnyType } from 'std:shared'

import {
  ACTION_CONTEXT,
  REST_TRANSFORMER,
  ROUTER,
  SERVER,
  TRANSPORT,
  WS_TRANSFORMER,
} from './const'
import { ActionContextRef } from './internal/contexts'
import type { Action, ActionContext } from './types/action'
import type { RestTransformerActions, RestTransformerContext } from './types/rest'
import type { RouterActions, RouterContext } from './types/router'
import type { ServerActions, ServerContext } from './types/server'
import type { TransportActions, TransportContext } from './types/transport'
import type { WsTransformerActions, WsTransformerContext } from './types/ws'
import { createEmptyReq, createEmptyRes } from './utils/create'

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

export const Transport = defineProtocol<TransportContext, unknown, unknown[], TransportActions>({
  name: 'transport',
  version: '0.0.1',
  subtype: TRANSPORT,

  defaultActions: {
    call: operation(function* (
      action: AnyType,
      body: unknown,
      parent?: ActionContext<unknown>,
    ): AnyType {
      const inherited = parent ?? (yield* ActionContextRef.get())
      const ctx: ActionContext<unknown> = {
        _t: ACTION_CONTEXT,
        type: 'internal',
        from: (action as Action & { title?: string }).title ?? 'internal',
        body,
        files: inherited?.files ?? {},
        meta: inherited?.meta ?? {},
        req: inherited?.req ?? createEmptyReq(body),
        res: inherited?.res ?? createEmptyRes(),
      }
      return yield* (action as AnyType)(ctx)
    }),

    // oxlint-disable-next-line require-yield
    settings: operation(function* (options: AnyType = {}) {
      const transport = Transport as AnyType

      return {
        // oxlint-disable-next-line oxc/no-rest-spread-properties
        ...options,

        transport,
      }
    }),
  },
})
