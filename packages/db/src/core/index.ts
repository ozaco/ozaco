/**
 * `@ozaco/db` — the reactive, adapter-agnostic database module. The core is pure structure: a
 * column DSL (`table`/`column`), a portable filter algebra (`eq`/`and`/…), the `DbAdapter`
 * protocol (backend bindings live at `db:impl/{memory,sqlite,pg,bun-sql}`) and the `Db`/`DbClient`
 * plugin whose context is the typed, watchable `Database.Handle`. Driver-free: importing this never
 * pulls in a database package.
 */
export * from './const'
export * from './errors'

export * from './definition/bus'
export * from './definition/database'
export * from './definition/protocol'

export * from './utils/adapter'
export * from './utils/database'
export * from './utils/evaluate'
export * from './utils/filter'
export * from './utils/is'
export * from './utils/kv'
export * from './utils/sanitize'
export * from './utils/schema'

export type * from './types/adapter'
export type * from './types/bus'
export type * from './types/change'
export type * from './types/database'
export type * from './types/helpers'
export type * from './types/kv'
export type * from './types/schema'
export type * from './types/spec'
