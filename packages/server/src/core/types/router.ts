import type { Future } from 'std:effect'
import type { AnyType } from 'std:shared'

import type { Service } from 'server:service'

import type { Helpers } from './helpers'

export interface RouterContext {
  router: AnyType
  transformer: Helpers.AnyRestTransformer
  compiled: (method: string, path: string) => AnyType
  handlers: Map<symbol, { handler: AnyType; key: string; settings: AnyType }>
}

export interface RouterActions extends Record<string, AnyType> {
  add: (method: string, pattern: string, payload: symbol) => Future<void, unknown>
  remove: (method: string, pattern: string) => Future<void, unknown>
  has: (method: string, pattern: string, payload?: symbol) => Future<boolean, unknown>

  find: (method: string, path: string) => Future<[data: symbol, params?: unknown], 'not-found'>

  optimize: () => Future<void, unknown>

  transformer: (transformer: Helpers.AnyRestTransformer) => Future<void, unknown>
  mount: (prefix: string, service: Service) => Future<void, unknown>
  unmount: (service: Service) => Future<void, unknown>
}
