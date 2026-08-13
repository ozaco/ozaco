// oxlint-disable import/exports-last
import type { COLUMN, SCHEMA, TABLE } from '../const'

import type { Simplify, SystemFields } from './common'

// --- Standard Schema (vendored interface, https://standardschema.dev — spec-sanctioned copy) ------

/** The Standard Schema v1 contract — any conforming validator (zod v4, valibot, arktype, …) can be
 * attached to a table via `table(name, columns, { validate })`. */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly '~standard': StandardSchemaV1.Props<Input, Output>
}

export namespace StandardSchemaV1 {
  export interface Props<Input = unknown, Output = Input> {
    readonly version: 1
    readonly vendor: string
    readonly validate: (value: unknown) => Result<Output> | Promise<Result<Output>>
    readonly types?: Types<Input, Output> | undefined
  }
  export type Result<Output> = SuccessResult<Output> | FailureResult
  export interface SuccessResult<Output> {
    readonly value: Output
    readonly issues?: undefined
  }
  export interface FailureResult {
    readonly issues: readonly Issue[]
  }
  export interface Issue {
    readonly message: string
    readonly path?: readonly (PropertyKey | PathSegment)[] | undefined
  }
  export interface PathSegment {
    readonly key: PropertyKey
  }
  export interface Types<Input = unknown, Output = Input> {
    readonly input: Input
    readonly output: Output
  }
}

// --- storage shape --------------------------------------------------------------------------------

/** The storage-level shape of a column. Adapters map each kind to their backend's native type. */
export type ColumnKind = 'text' | 'int' | 'float' | 'boolean' | 'timestamp' | 'json' | 'enum'

/** One column as the adapter sees it — pure data, no DSL machinery. */
export interface ColumnSpec {
  readonly name: string
  readonly kind: ColumnKind
  readonly optional: boolean
  readonly hasDefault: boolean
  readonly enumValues: readonly string[] | null
  /** the referenced table when declared via `column.id('table')`, otherwise null. */
  readonly reference: string | null
  /** true for the implicit `_id`/`_createdAt`/`_version` columns. */
  readonly system: boolean
  /** true for the primary-key column (`_id`). */
  readonly primary: boolean
}

export interface IndexSpec {
  readonly name: string
  readonly columns: readonly string[]
  readonly unique: boolean
}

/** Everything an adapter needs to know about one table: name + ALL columns (system included) +
 * declared indexes. Core builds this from a {@link TableDef}; adapters stay schema-stateless. */
export interface TableSpec {
  readonly name: string
  readonly columns: readonly ColumnSpec[]
  readonly indexes: readonly IndexSpec[]
}

// --- column DSL -----------------------------------------------------------------------------------

declare const VALUE: unique symbol

/** The DSL-side column metadata (turned into a {@link ColumnSpec} by `table()`). */
export interface ColumnMeta {
  readonly optional: boolean
  readonly hasDefault: boolean
  readonly defaultValue: (() => unknown) | null
  readonly enumValues: readonly string[] | null
  readonly reference: string | null
}

/**
 * A column declaration produced by the `column.*` builders. Carries the resolved TS value type as a
 * phantom; `optional()` makes the stored value nullable (and the insert key omittable), `default()`
 * keeps the value required in storage but omittable on insert.
 */
export interface ColumnDef<
  TValue = unknown,
  TOptional extends boolean = boolean,
  THasDefault extends boolean = boolean,
> {
  readonly _t: typeof COLUMN
  readonly kind: ColumnKind
  readonly meta: ColumnMeta
  optional(): ColumnDef<TValue, true, THasDefault>
  default(value: TValue | (() => TValue)): ColumnDef<TValue, TOptional, true>
  /** phantom carrier for the value type + flags — never present at runtime. */
  readonly [VALUE]?: {
    readonly value: TValue
    readonly optional: TOptional
    readonly hasDefault: THasDefault
  }
}

export type ColumnShape = Record<string, ColumnDef>

/** The stored value type of one column: optional columns hold `T | null`. */
export type ColumnValue<TColumn> =
  TColumn extends ColumnDef<infer TValue, infer TOptional, boolean>
    ? TOptional extends true
      ? TValue | null
      : TValue
    : never

type InsertOptionalKeys<TShape extends ColumnShape> = {
  [K in keyof TShape]: TShape[K] extends ColumnDef<unknown, infer TOptional, infer THasDefault>
    ? TOptional extends true
      ? K
      : THasDefault extends true
        ? K
        : never
    : never
}[keyof TShape]

/** The resolved stored-row type for a column shape (system fields included). */
export type DocFor<TShape extends ColumnShape> = Simplify<
  { readonly [K in keyof TShape]: ColumnValue<TShape[K]> } & SystemFields
>

/** The accepted insert type for a column shape: optional/defaulted columns may be omitted. */
export type InsertFor<TShape extends ColumnShape> = Simplify<
  {
    readonly [K in Exclude<keyof TShape, InsertOptionalKeys<TShape>>]: ColumnValue<TShape[K]>
  } & {
    readonly [K in InsertOptionalKeys<TShape>]?: ColumnValue<TShape[K]> | undefined
  }
>

// --- table / schema -------------------------------------------------------------------------------

declare const DOC: unique symbol
declare const INSERT: unique symbol

/** A declared table: name, derived column specs (user columns only), indexes and the optional
 * Standard Schema validator. The resolved row/insert types travel as phantoms so downstream hovers
 * stay flat (no DSL machinery). */
export interface TableDef<TName extends string = string, TDoc = unknown, TInsert = unknown> {
  readonly _t: typeof TABLE
  readonly name: TName
  readonly columns: readonly ColumnSpec[]
  readonly indexes: readonly IndexSpec[]
  /** insert-time default factories, keyed by column name (from `column.*().default(...)`). */
  readonly defaults: Readonly<Record<string, () => unknown>>
  /** table-level insert/replace validator (any Standard Schema v1 library), or null. */
  readonly validate: StandardSchemaV1 | null
  readonly [DOC]?: TDoc
  readonly [INSERT]?: TInsert
}

export type TableMap = Record<string, TableDef>

export interface SchemaDef<TTables extends TableMap = TableMap> {
  readonly _t: typeof SCHEMA
  readonly tables: TTables
}

/** Per-table resolved types the {@link Schema} is keyed by: the stored row + the accepted insert. */
export interface TableTypes<TDoc = unknown, TInsert = unknown> {
  readonly doc: TDoc
  readonly insert: TInsert
}

/** A type-only schema: table name → its resolved `{ doc, insert }`. Decoupled from the runtime
 * {@link SchemaDef} so `Database` hovers show plain rows. */
export type Schema = Record<string, TableTypes>

/** Build a {@link Schema} from a tuple of standalone tables — powers `useDb(...tables)` typing. */
export type SchemaFrom<TTables extends readonly TableDef[]> = {
  readonly [Table in TTables[number] as Table['name']]: Table extends TableDef<
    string,
    infer TDoc,
    infer TInsert
  >
    ? { readonly doc: TDoc; readonly insert: TInsert }
    : never
}

/** The stored-row type of one declared table. */
export type Infer<TTable extends TableDef> =
  TTable extends TableDef<string, infer TDoc, unknown> ? TDoc : never

/** The accepted insert type of one declared table. */
export type InferInsert<TTable extends TableDef> =
  TTable extends TableDef<string, unknown, infer TInsert> ? TInsert : never
