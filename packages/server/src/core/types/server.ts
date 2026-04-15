import type { Future } from 'std:effect'
import type { AnyType } from 'std:shared'

export interface ServerContext {
  port: number
  host: string
}

export interface ServerActions extends Record<string, AnyType> {
  start(): Future<void, unknown>
  pause(): Future<void, unknown>
  resume(): Future<void, unknown>
  destroy(): Future<void, unknown>
}
