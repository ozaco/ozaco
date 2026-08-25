import type { AnyType } from 'std:shared'

export namespace Pg {
  export interface Options {
    /** `postgres://…` connection string. */
    readonly url: string

    /** Driver pool size (node-postgres `max`). Default 10. */
    readonly max?: number | undefined
    readonly ssl?: AnyType
  }

  export interface Connection {
    readonly url: string
    readonly ssl?: AnyType
  }

  export interface State {
    readonly pool: AnyType
    readonly connection: Connection
  }
}
