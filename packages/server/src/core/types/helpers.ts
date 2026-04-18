import type { Plugin } from 'std:plugin'
import type { AnyType } from 'std:shared'

import type { RouterActions, RouterContext } from './router'
import type { RestTransformerActions, RestTransformerContext } from './transformer'

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
}
