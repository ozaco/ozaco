import type { Context, Operation } from 'std:effect'
import type { AnyType } from 'std:shared'

import type { Namespace, Plugin } from './plugin'

export namespace Helpers {
  export type InferPluginContext<T> = T extends Plugin<infer V> ? V[0] : never
  export type InferNamespaceContext<T> = T extends Namespace<infer V> ? V : never
  export type InferContext<T> = T extends Context<infer V> ? V : never

  export interface Use {
    <T extends Context<AnyType>>(ctx: T): Helpers.InferContext<T>
    <T extends Plugin>(plugin: T): Helpers.InferPluginContext<T>
    <T extends Namespace>(ns: T): Helpers.InferNamespaceContext<T>
  }

  export type AnyAction = (...args: AnyType[]) => Operation<unknown, unknown>
}
