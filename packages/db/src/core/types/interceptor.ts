import type { Plugin } from 'std:plugin'
import type { AnyType } from 'std:shared'

import type { Interceptor } from './common'

/** The interceptor protocol as a plugin type. The context IS the {@link Interceptor} the plugin
 * registers; the protocol is cloneable so multiple interceptors install at once. No actions. */
export type InterceptorDef = Plugin<InterceptorDef.Context, [InterceptorDef.Options?]>

export namespace InterceptorDef {
  export type Context = Interceptor
  /** Per-interceptor install options (varies by interceptor); generic at the protocol level. */
  export type Options = AnyType
}
