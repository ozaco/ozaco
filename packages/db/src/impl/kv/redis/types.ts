import type { KvDef } from 'db:core'
import type { AnyType } from 'std:shared'

export namespace RedisKvDef {
  export interface Options extends KvDef.CommonOptions {
    /** `redis://…` connection string. */
    readonly url: string

    /** Extra `createClient` options (tls, socket, password, …) merged under `url`. */
    readonly client?: Record<string, unknown> | undefined
  }

  /** The client factory the store dials through (injectable for fakes). */
  export interface ImplLike {
    createClient(options: Record<string, unknown>): AnyType
  }

  export interface State {
    readonly client: AnyType

    /** the same connection answering blob strings as `Buffer` (values are bytes). */
    readonly bytes: AnyType
    closed: boolean
  }
}
