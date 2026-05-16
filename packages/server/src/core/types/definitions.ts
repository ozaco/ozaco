import type { Future } from 'std:effect'
import type { AnyType } from 'std:shared'

export namespace Definitions {
  export interface ServerContext {
    port: number
    host: string
  }

  export interface ServerActions extends Record<string, AnyType> {
    start(options: Partial<ServerContext>): Future<ServerContext, unknown>
    isStarted(): Future<boolean, unknown>
    pause(cause: string): Future<void, unknown>
    isPaused(): Future<false | string, unknown>
    resume(): Future<void, unknown>
    destroy(): Future<void, unknown>
  }
}
