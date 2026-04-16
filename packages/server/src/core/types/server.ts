import type { Future } from 'std:effect'
import type { AnyType } from 'std:shared'

export interface ServerContext {
  port: number
  host: string
}

export interface ServerActions extends Record<string, AnyType> {
  start(options: Partial<ServerContext>): Future<ServerContext, unknown>
  isStarted(): Future<boolean, unknown>
  pause(): Future<void, unknown>
  isPaused(): Future<boolean, unknown>
  resume(): Future<void, unknown>
  destroy(): Future<void, unknown>
}
