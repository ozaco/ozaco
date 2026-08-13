declare const ID_BRAND: unique symbol

/** An opaque record id branded by the table it points at. The runtime value is a plain string. */
export type Id<TTable extends string = string> = string & { readonly [ID_BRAND]: TTable }

/** A value a document field can hold at the app level (adapters en/decode storage shapes). */
export type Value =
  | string
  | number
  | boolean
  | null
  | Date
  | readonly unknown[]
  | Record<string, unknown>

/** The untyped stored-row shape — validated user columns plus the system fields. */
export type Doc = Record<string, unknown>

/** The fields stamped on every stored document, regardless of backend. */
export interface SystemFields {
  readonly _id: string
  readonly _createdAt: number
  /** Epoch millis of the last `patch`/`replace` (equals `_createdAt` until then). */
  readonly _updatedAt: number
  readonly _version: number
}

/** Flatten a type into a single plain object so TS materializes (and displays) it eagerly. */
export type Simplify<T> = { [K in keyof T]: T[K] } & {}
