import type { Schema } from './schema'

/** The types of the public helpers (`column.*`, …) that are not a module's own protocol. */
export namespace Utils {
  export interface TimestampOptions {
    /** `'date'` (default) reads back a `Date`; `'ms'` keeps epoch millis as a `number`. */
    readonly as?: 'date' | 'ms' | undefined
  }

  /** `column.timestamp` — the value type follows `as`. */
  export interface Timestamp {
    (options?: { readonly as?: 'date' | undefined }): Schema.Column<Date, false, false>
    (options: { readonly as: 'ms' }): Schema.Column<number, false, false>
  }
}
