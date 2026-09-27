import type { Operation } from 'std:effect'
import type { ResultDef } from 'std:result'

/** The shapes {@link serviceErrors} builds — a service's failure taxonomy declared once. */
export namespace ErrorsDef {
  /** `'not-found'` → `'notFound'`: the kebab tag as a property name. */
  export type Camel<S extends string> = S extends `${infer Head}-${infer Tail}`
    ? `${Head}${Capitalize<Camel<Tail>>}`
    : S

  /** One failure: call it to raise, read `.tag` where a tag string is wanted (`retry.when`,
   * `cache.tags`, a comparison against `failure.error`). Its causes are `fail`'s: strings, and
   * the failures it wraps (nested as they are; a foreign error goes in as `asFailure(error)`). */
  export interface Failer<TTag extends string> {
    (message?: string, ...causes: ResultDef.CauseInput[]): Operation<never>
    readonly tag: TTag
  }

  export type Statuses<TPrefix extends string, TMap extends Record<string, number>> = {
    readonly [K in keyof TMap & string as `${TPrefix}.${K}`]: number
  }

  export type Catalog<TPrefix extends string, TMap extends Record<string, number>> = {
    readonly [K in keyof TMap & string as Camel<K>]: Failer<`${TPrefix}.${K}`>
  } & {
    /** the `errors` field of an action config: tag → HTTP status. */
    readonly statuses: Statuses<TPrefix, TMap>
  }
}
