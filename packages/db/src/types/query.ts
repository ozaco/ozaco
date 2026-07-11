import type { Future, Operation } from 'std:effect'

import type { InferInsert, InferRow } from '../utils/schema/infer'
import type { TableDef } from '../utils/schema/types'

export type WhereClause<TTable extends TableDef> = Partial<InferRow<TTable>>

export type OrderDirection = 'asc' | 'desc'

export interface SelectQuery<TTable extends TableDef> {
  where(clause: WhereClause<TTable>): SelectQuery<TTable>
  limit(count: number): SelectQuery<TTable>
  offset(count: number): SelectQuery<TTable>
  orderBy(column: keyof InferRow<TTable> & string, direction?: OrderDirection): SelectQuery<TTable>
  all(): Future<InferRow<TTable>[]>
  first(): Future<InferRow<TTable> | null>
  firstOrFail(): Future<InferRow<TTable>>
}

export interface InsertReturning<TTable extends TableDef> {
  all(): Future<InferRow<TTable>[]>
  first(): Future<InferRow<TTable> | null>
  firstOrFail(): Future<InferRow<TTable>>
}

export interface InsertQuery<TTable extends TableDef> {
  values(row: InferInsert<TTable>): InsertQuery<TTable>
  valuesMany(rows: InferInsert<TTable>[]): InsertQuery<TTable>
  returning(): InsertReturning<TTable>
  execute(): Future<void>
}

export interface UpdateReturning<TTable extends TableDef> {
  all(): Future<InferRow<TTable>[]>
  first(): Future<InferRow<TTable> | null>
}

export interface UpdateQuery<TTable extends TableDef> {
  set(values: Partial<InferRow<TTable>>): UpdateQuery<TTable>
  where(clause: WhereClause<TTable>): UpdateQuery<TTable>
  returning(): UpdateReturning<TTable>
  execute(): Future<number>
}

export interface DeleteQuery<TTable extends TableDef> {
  where(clause: WhereClause<TTable>): DeleteQuery<TTable>
  execute(): Operation<number>
}

export interface QueryBuilder {
  from<TTable extends TableDef>(table: TTable): SelectQuery<TTable>
  insert<TTable extends TableDef>(table: TTable): InsertQuery<TTable>
  update<TTable extends TableDef>(table: TTable): UpdateQuery<TTable>
  delete<TTable extends TableDef>(table: TTable): DeleteQuery<TTable>
  transaction<T>(fn: (tx: QueryBuilder) => Future<T>): Operation<T>
  raw<T = unknown>(sql: string, params?: unknown[]): Future<T[]>
}
