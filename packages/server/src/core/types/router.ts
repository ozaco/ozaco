import type { Future } from 'std:effect'
import type { AnyType } from 'std:shared'

import type { Action } from './action'
import type { Service } from './service'

export interface RouterContext {
  router: AnyType
  compiled: (method: string, path: string) => AnyType
  handlers: Map<symbol, Record<string, AnyType>>
}

export interface RouterActions extends Record<string, AnyType> {
  add: (method: string, pattern: string, payload: symbol) => Future<void, unknown>
  remove: (method: string, pattern: string) => Future<void, unknown>
  has: (method: string, pattern: string, payload?: symbol) => Future<boolean, unknown>

  find: (method: string, path: string) => Future<[data: symbol, params?: unknown], 'not-found'>

  optimize: () => Future<void, unknown>

  mount: (prefix: string, target: Service | Action) => Future<void, unknown | 'missing-settings'>
  unmount: (target: Service | Action) => Future<void, unknown>
}
