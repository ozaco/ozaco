import type { AnyType } from 'std:shared'

export namespace BunSql {
  export interface Options {
    /** `postgres://…` connection string. */
    readonly url: string

    /** Driver pool size (Bun SQL `max`). Default 10. */
    readonly max?: number | undefined
  }

  export interface State {
    readonly client: AnyType
  }
}
