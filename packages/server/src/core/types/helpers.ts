import type { Plugin } from 'std:plugin'
import type { AnyType } from 'std:shared'

import type { RestTransformerActions, RestTransformerContext } from './rest-transformer'
import type { RouterActions, RouterContext } from './router'
import type { WsOptions, WsTransformerActions, WsTransformerContext } from './ws-transformer'

export namespace Helpers {
  export type DefaultRouter = Plugin<RouterContext, unknown, [], RouterActions>

  export type DefaultRestTransformer = Plugin<
    RestTransformerContext,
    unknown,
    [],
    RestTransformerActions
  >

  export type AnyRestTransformer = Plugin<
    RestTransformerContext,
    AnyType,
    AnyType,
    RestTransformerActions
  >

  export type DefaultWsTransformer = Plugin<
    WsTransformerContext,
    unknown,
    [WsOptions?],
    WsTransformerActions
  >

  export type AnyWsTransformer = Plugin<
    WsTransformerContext,
    AnyType,
    AnyType,
    WsTransformerActions
  >
}
