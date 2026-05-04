import { operation } from 'std:effect'
import { defineProtocol } from 'std:plugin'
import type { AnyType } from 'std:shared'

import { REST_TRANSFORMER, ROUTER, SERVER, TRANSPORT, WS_TRANSFORMER } from './const'
import {
  ActionRawRequestContext,
  ActionRawResponseContext,
  ActionRequestContext,
  ActionResponseContext,
  ActionSignalContext,
} from './internal/contexts'
import type { ActionRequest, ActionResponse } from './types/action'
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

export const Rest = defineProtocol<
  RestTransformerContext,
  unknown,
  [options?: RestTransformerContext],
  RestTransformerActions
>({
  name: 'rest-transformer',
  version: '0.0.1',
  subtype: REST_TRANSFORMER,
})

export const Ws = defineProtocol<
  WsTransformerContext,
  unknown,
  [options?: WsTransformerContext],
  WsTransformerActions
>({
  name: 'ws-transformer',
  version: '0.0.1',
  subtype: WS_TRANSFORMER,

  defaultActions: {
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
    call: operation(function* (action: AnyType, body: unknown, options?: AnyType): AnyType {
      const parent = options?.parent as ActionRequest | undefined
      const inheritedReq = parent ?? (yield* ActionRequestContext.get())
      const inheritedRes = (yield* ActionResponseContext.get()) ?? null
      const inheritedRawReq = (yield* ActionRawRequestContext.get()) ?? null
      const inheritedRawRes = (yield* ActionRawResponseContext.get()) ?? null

      const req: ActionRequest = inheritedReq
        ? // oxlint-disable-next-line oxc/no-rest-spread-properties
          { ...inheritedReq, type: 'internal', from: 'internal' }
        : createEmptyReq()
      const res: ActionResponse = inheritedRes ?? createEmptyRes()

      const signal = options?.signal as AbortSignal | undefined

      return yield* ActionRequestContext.with(req, function* () {
        return yield* ActionResponseContext.with(res, function* () {
          return yield* ActionRawRequestContext.with(inheritedRawReq, function* () {
            return yield* ActionRawResponseContext.with(inheritedRawRes, function* () {
              if (signal) {
                return yield* ActionSignalContext.with(signal, function* () {
                  return yield* (action as AnyType)(body)
                })
              }
              return yield* (action as AnyType)(body)
            })
          })
        })
      })
    }),

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
