/**
 * TYPE tests: the contracts that must hold at COMPILE time. `bun test` only proves the runtime
 * lines at the bottom — the real assertions are the `@ts-expect-error` markers and the explicit
 * annotations inside `probe`, which `moon run db:types` (tsc) checks. A marker that stops being
 * an error is itself an error, so a regression in either direction fails the build.
 *
 * The probes are never called: a generator body is type-checked all the same.
 */
import type { Database, Schema } from 'db:core'
import { column, defineSchema, table, useDb, where } from 'db:core'
import type { Operation } from 'std:effect'

import { describe, expect, it } from 'bun:test'

const todos = table('todos', {
  title: column.text(),
  done: column.boolean(),
  priority: column.enumOf('low', 'high'),
  size: column.int(),
  note: column.text().optional(),
  meta: column.json<{ tags: string[] }>().optional(),
  due: column.timestamp().optional(),
})

const tags = table('tags', {
  todo: column.id('todos'),
  label: column.text(),
})

const schema = defineSchema({ todos, tags })

type Db = Database.Handle<Schema.From<[typeof todos]>>

declare const db: Db

/** A handle with no declared schema — rows are plain documents, every field name is allowed. */
declare const loose: Database.Handle

/** Statements that must (or must not) COMPILE. Never called — `declare const` has no runtime
 * value, so everything here lives inside a function body. */
const accepts = (): void => {
  // --- filters name real columns ---------------------------------------------------------------

  db.query('todos').filter(where.eq('done', false))
  db.query('todos').filter(where.and(where.eq('done', false), where.gt('size', 3)))
  db.query('todos').filter(where.oneOf('priority', ['low']))
  db.query('todos').filter(where.not(where.isNull('note')))

  // @ts-expect-error 'dnoe' is not a column of todos
  db.query('todos').filter(where.eq('dnoe', false))

  // @ts-expect-error the typo survives composition
  db.query('todos').filter(where.and(where.eq('done', false), where.gt('siez', 3)))

  // a wire filter has no static shape — an untyped handle takes any field
  loose.query('anything').filter(where.eq('whatever', 1))

  // --- order keys name real columns, and stack -------------------------------------------------

  db.query('todos').order('priority', 'desc').order('title')

  // @ts-expect-error 'nope' is not a column
  db.query('todos').order('nope')

  // --- projections may only name real columns --------------------------------------------------

  db.query('todos').select('title', 'size')

  // @ts-expect-error a projection may only name real columns
  db.query('todos').select('title', 'nope')

  // --- aggregates ------------------------------------------------------------------------------

  db.query('todos').sum('size')
  db.query('todos').avg('size')
  db.query('todos').max('title')

  // @ts-expect-error `title` is text — sum/avg are for numeric columns
  db.query('todos').sum('title')

  // @ts-expect-error grouping may only name real columns
  db.query('todos').groupBy('nope')

  // --- writes ----------------------------------------------------------------------------------

  db.upsert('todos', { title: 'x' }, { title: 'x', done: false, priority: 'low', size: 1 })

  // `value` may omit what `match` pins (the insert branch writes `{ ...match, ...value }`)
  db.upsert('todos', { title: 'x' }, { done: false })

  // @ts-expect-error a value field still has to fit its column
  db.upsert('todos', { title: 'x' }, { done: 'yes' })

  // @ts-expect-error 'urgent' is not a member of the enum
  db.insert('todos', { title: 'x', done: false, priority: 'urgent', size: 1 })
}

void accepts

/** The v0.5 seams: one schema declaration, id annotation, match narrowing, scope typing. */
function* seams(): Operation<void> {
  // useDb(schema) resolves the SAME typed handle the tables would — one declaration
  const fromSchema = yield* useDb(schema)
  const row = (yield* fromSchema.query('todos').first())!
  const title: string = row.title
  void title

  // @ts-expect-error a table the schema does not declare is a compile error
  fromSchema.query('nope')

  // `_id` is annotated with its table; an id column takes it — and a plain string too
  const tag = yield* fromSchema.insert('tags', { todo: row._id, label: 'x' })
  yield* fromSchema.insert('tags', { todo: 'plain-string-id', label: 'y' })
  const backref: Schema.Id<'todos'> = tag.todo
  void backref

  // `where(match)` narrows to comparable columns — json/Date columns do not fit an equality
  fromSchema.query('todos').where({ title: 'x', done: false })

  // @ts-expect-error a json column is not an equality match — use `filter(...)` deliberately
  fromSchema.query('todos').where({ meta: { tags: [] } })

  // a timestamp IS comparable — Date is a filter value
  fromSchema.query('todos').where({ due: new Date() })

  // per-call scope filters are checked against the row's columns
  yield* fromSchema.get('todos', 'id', { scope: where.eq('done', false) })

  // @ts-expect-error a scope naming an unknown column does not compile
  yield* fromSchema.get('todos', 'id', { scope: where.eq('tenant', 'a') })

  // a scoped handle keeps the schema's typing
  const scoped = fromSchema.scoped(where.eq('done', false))
  const scopedRow = (yield* scoped.query('todos').first())!
  const scopedTitle: string = scopedRow.title
  void scopedTitle
}

void seams

/** What the terminals INFER, asserted by annotation. */
function* probe(): Operation<void> {
  const rows = yield* db.query('todos').collect()
  const row = rows[0]!
  const title: string = row.title
  const priority: 'low' | 'high' = row.priority
  const note: string | null = row.note
  void [title, priority, note]

  // a projection keeps what was picked plus the system fields, and drops the rest
  const picked = (yield* db.query('todos').select('title', 'size').collect())[0]!
  const pickedTitle: string = picked.title
  const pickedSize: number = picked.size
  const pickedId: string = picked._id
  const pickedVersion: string = picked._version
  void [pickedTitle, pickedSize, pickedId, pickedVersion]

  // @ts-expect-error `done` was not selected
  void picked.done

  const total: number = yield* db.query('todos').sum('size')
  const mean: number | null = yield* db.query('todos').avg('size')
  const biggest: string | null = yield* db.query('todos').max('title')
  void [total, mean, biggest]

  // a grouped answer carries the grouped columns plus the aggregate — nothing else
  const group = (yield* db.query('todos').groupBy('priority').count())[0]!
  const key: 'low' | 'high' = group.priority
  const howMany: number = group.count
  void [key, howMany]

  // @ts-expect-error the group answer carries the keys and the aggregate only
  void group.title

  const upserted = yield* db.upsert(
    'todos',
    { title: 'x' },
    { title: 'x', done: false, priority: 'low', size: 1 },
  )
  const upsertedId: string = upserted._id
  void upsertedId
}

void probe

describe('db — types', () => {
  it('the filter builders produce the portable shape they are typed as', () => {
    expect(where.eq('done', false)).toEqual({ op: 'eq', field: 'done', value: false })

    expect(where.and(where.eq('done', false), where.gt('size', 3))).toEqual({
      op: 'and',
      filters: [
        { op: 'eq', field: 'done', value: false },
        { op: 'gt', field: 'size', value: 3 },
      ],
    })

    expect(where.ilike('title', 'a%')).toEqual({
      op: 'like',
      field: 'title',
      pattern: 'a%',
      insensitive: true,
    })
  })
})
