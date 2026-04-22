import type { ColumnDef, TableDef } from './types'

type ColumnJs<TCol extends ColumnDef> = TCol extends ColumnDef<infer TJs> ? TJs : never

export type InferRow<TTable extends TableDef> =
  TTable extends TableDef<infer _TName, infer TCols>
    ? { [K in keyof TCols]: ColumnJs<TCols[K]> }
    : never

export type InferInsert<TTable extends TableDef> =
  TTable extends TableDef<infer _TName, infer TCols>
    ? Partial<{ [K in keyof TCols]: ColumnJs<TCols[K]> }>
    : never
