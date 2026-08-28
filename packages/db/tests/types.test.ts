/**
 * TYPE tests: the contracts that must hold at COMPILE time. `bun test` only proves the runtime
 * lines at the bottom — the real assertions are the `@ts-expect-error` markers and the explicit
 * annotations inside `probe`, which `moon run db:types` (tsc) checks. A marker that stops being
 * an error is itself an error, so a regression in either direction fails the build.
 *
 * The probes are never called: a generator body is type-checked all the same.
 */
import type { Database, Schema } from 'db:core'
import { column, table, where } from 'db:core'
import type { Operation } from 'std:effect'

import { describe, expect, it } from 'bun:test'

const todos = table('todos', {
  title: column.text(),
  done: column.boolean(),
  priority: column.enumOf('low', 'high'),
  size: column.int(),
  note: column.text().optional(),
})

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

  // @ts-expect-error `done` is required by the insert shape
  db.upsert('todos', { title: 'x' }, { title: 'x' })

  // @ts-expect-error 'urgent' is not a member of the enum
  db.insert('todos', { title: 'x', done: false, priority: 'urgent', size: 1 })
}

void accepts

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
