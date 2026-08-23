import type { StandardSchemaV1 } from 'std:shared'

import type { COLUMN, TABLE } from '../const'

import type { Spec } from './spec'

declare const ID_BRAND: unique symbol
declare const VALUE: unique symbol
declare const DOC: unique symbol
declare const INSERT: unique symbol

/**
 * The schema DSL's type layer: what `column.*` and `table()` produce, and how a declared table
 * resolves to its stored-row / accepted-insert types. Everything here is compile-time; the
 * runtime counterpart is `Spec` (what adapters consume).
 */
export namespace Schema {
  /** An opaque record id branded by the table it points at. The runtime value is a plain string. */
  export type Id<TTable extends string = string> = string & { readonly [ID_BRAND]: TTable }

  /** The fields stamped on every stored document, regardless of backend. */
  export interface SystemFields {
    readonly _id: string
    readonly _createdAt: number

    /** Epoch millis of the last `patch`/`replace` (equals `_createdAt` until then). */
    readonly _updatedAt: number

    /** The HLC token of the last write that produced this row (`VERSION_ZERO` for rows written
     * outside the handle). Time-sortable; `ifVersion` compares it by equality. */
    readonly _version: string
  }

  /** Flatten a type into a single plain object so TS materializes (and displays) it eagerly. */
  export type Simplify<T> = { [K in keyof T]: T[K] } & {}

  /** The DSL-side column metadata (turned into a {@link Spec.Column} by `table()`). */
  export interface ColumnMeta {
    readonly optional: boolean
    readonly hasDefault: boolean
    readonly defaultValue: (() => unknown) | null
    readonly enumValues: readonly string[] | null
  }

  /**
   * A column declaration produced by the `column.*` builders. Carries the resolved TS value type as
   * a phantom; `optional()` makes the stored value nullable (and the insert key omittable),
   * `default()` keeps the value required in storage but omittable on insert.
   */
  export interface Column<
    TValue = unknown,
    TOptional extends boolean = boolean,
    THasDefault extends boolean = boolean,
  > {
    readonly _t: typeof COLUMN
    readonly kind: Spec.ColumnKind
    readonly meta: ColumnMeta
    optional(): Column<TValue, true, THasDefault>
    default(value: TValue | (() => TValue)): Column<TValue, TOptional, true>

    /** phantom carrier for the value type + flags — never present at runtime. */
    readonly [VALUE]?: {
      readonly value: TValue
      readonly optional: TOptional
      readonly hasDefault: THasDefault
    }
  }

  export type Shape = Record<string, Column>

  /** The stored value type of one column: optional columns hold `T | null`. */
  export type ValueOf<TColumn> =
    TColumn extends Column<infer TValue, infer TOptional, boolean>
      ? TOptional extends true
        ? TValue | null
        : TValue
      : never

  type OmittableKeys<TShape extends Shape> = {
    [K in keyof TShape]: TShape[K] extends Column<unknown, infer TOptional, infer THasDefault>
      ? TOptional extends true
        ? K
        : THasDefault extends true
          ? K
          : never
      : never
  }[keyof TShape]

  /** The resolved stored-row type for a column shape (system fields included). */
  export type DocFor<TShape extends Shape> = Simplify<
    { readonly [K in keyof TShape]: ValueOf<TShape[K]> } & SystemFields
  >

  /** The accepted insert type for a column shape: optional/defaulted columns may be omitted. */
  export type InsertFor<TShape extends Shape> = Simplify<
    {
      readonly [K in Exclude<keyof TShape, OmittableKeys<TShape>>]: ValueOf<TShape[K]>
    } & {
      readonly [K in OmittableKeys<TShape>]?: ValueOf<TShape[K]> | undefined
    }
  >

  /** A declared table: name, derived column specs (user columns only), indexes and the optional
   * Standard Schema validator. The resolved row/insert types travel as phantoms so downstream
   * hovers stay flat (no DSL machinery). */

  export interface Table<TName extends string = string, TDoc = unknown, TInsert = unknown> {
    readonly _t: typeof TABLE
    readonly name: TName
    readonly columns: readonly Spec.Column[]
    readonly indexes: readonly Spec.Index[]

    /** insert-time default factories, keyed by column name (from `column.*().default(...)`). */
    readonly defaults: Readonly<Record<string, () => unknown>>

    /** table-level insert/replace validator (any Standard Schema v1 library), or null. */
    readonly validate: StandardSchemaV1 | null

    /** whether the table keeps a hidden change log (`__changes_<name>`). Default true. */
    readonly log: boolean
    readonly [DOC]?: TDoc
    readonly [INSERT]?: TInsert
  }

  /** A {@link Table} plus fluent index declaration. Index columns are checked against the row's
   * own field names. */
  export interface Builder<TName extends string, TDoc, TInsert> extends Table<
    TName,
    TDoc,
    TInsert
  > {
    index(name: string, columns: (keyof TDoc & string)[]): Builder<TName, TDoc, TInsert>
    unique(name: string, columns: (keyof TDoc & string)[]): Builder<TName, TDoc, TInsert>
  }

  export interface TableOptions {
    /** Table-level insert/replace validator — any Standard Schema v1 library (zod v4, valibot, …).
     * Runs on the user value (defaults applied, system fields excluded). Not applied to `patch`. */
    readonly validate?: StandardSchemaV1 | undefined

    /** `false` → no hidden change log for this table: writes still announce events to the local
     * hub and the bus, but peers cannot replay them (a lost envelope stays lost) and `since:`
     * watchers always start from a snapshot. For write-heavy tables whose history nobody needs
     * (observability rows, caches). Default true. */
    readonly log?: boolean | undefined
  }

  /** Per-table resolved types a {@link Map} is keyed by: the stored row + the accepted insert. */
  export interface Types<TDoc = unknown, TInsert = unknown> {
    readonly doc: TDoc
    readonly insert: TInsert
  }

  /** A type-only schema: table name → its resolved `{ doc, insert }`. Decoupled from the runtime
   * {@link Table} so `Database.Handle` hovers show plain rows. */
  export type Map = Record<string, Types>

  /** Build a {@link Map} from a tuple of standalone tables — powers `useDb(...tables)` typing. */
  export type From<TTables extends readonly Table[]> = {
    readonly [Entry in TTables[number] as Entry['name']]: Entry extends Table<
      string,
      infer TDoc,
      infer TInsert
    >
      ? { readonly doc: TDoc; readonly insert: TInsert }
      : never
  }

  /** The stored-row type of one declared table. */
  export type Infer<TTable extends Table> =
    TTable extends Table<string, infer TDoc, unknown> ? TDoc : never

  /** The accepted insert type of one declared table. */
  export type InferInsert<TTable extends Table> =
    TTable extends Table<string, unknown, infer TInsert> ? TInsert : never
}
