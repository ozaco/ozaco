# @ozaco/db

A reactive, adapter-agnostic database module. You declare tables with a column DSL; every read is
a lazily-built query you can also **watch**; every write announces a change that watchers — and
other nodes — see. The backend is a plugin: the same code runs on memory, SQLite, Postgres or
Bun's SQL.

```
table()/column()  ──▶  DbClient  ──▶  Database.Handle
                          │              │
                  DbAdapter (memory/sqlite/pg/bun-sql)
                          │
                     change log ──▶ watchers  ──▶ DbBus ──▶ other nodes
```

Importing `@ozaco/db` never pulls in a database driver — the bindings live behind
`@ozaco/db/impl/*`.

## The smallest use

```ts
import { column, DbClient, table, useDb, where } from '@ozaco/db'
import { MemoryAdapter } from '@ozaco/db/impl/memory'
import { main } from '@ozaco/std/effect'
import { BunIO } from '@ozaco/std/io/impl/bun'

const todos = table('todos', {
  title: column.text(),
  done: column.boolean().default(() => false),
  priority: column.enumOf('low', 'normal', 'high').default(() => 'normal'),
})

await main(function* () {
  yield* BunIO.use()
  yield* MemoryAdapter.use()
  yield* DbClient.use({ tables: [todos] })

  const db = yield* useDb(todos)

  yield* db.insert('todos', { title: 'write the README' })

  const open = yield* db.query('todos').filter(where.eq('done', false)).order('priority').collect()
  //    open[0].title  → string, no cast
})
```

`useDb(...tables)` resolves the installed handle typed by the tables you name — the argument is
type-only, nothing is read from it at runtime.

## Declaring

```ts
const users = table('users', {
  email: column.text(),
  name: column.text(),
  age: column.int().optional(),
  role: column.enumOf('admin', 'member').default(() => 'member'),
  tags: column.json<readonly string[]>(),
  joined: column.timestamp().optional(),
  team: column.id('teams'), //  a text column, branded with the table it points at
})
  .unique('by_email', ['email'])
  .index('by_role', ['role'])
```

`_id`, `_created_at`, `_updated_at` and `_version` are implicit on every row. Schema reconcile runs
at install (`migrations: 'auto'`); `safe: true` skips the destructive steps.

## Reading

|                                                             |                                                                                                                                                                      |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.where({ role: 'admin' })`                                 | equality shorthand                                                                                                                                                   |
| `.filter(where.eq('done', false), …)`                       | the portable algebra — `eq ne gt gte lt lte oneOf notOneOf like ilike isNull notNull and or not`. Field names are checked against the table: a typo does not compile |
| `.order('priority', 'desc').order('title')`                 | sort keys **stack**, `_id` closes them as a tiebreak                                                                                                                 |
| `.select('title', 'size')`                                  | read only these columns (the system fields ride along, so paging and watching keep working)                                                                          |
| `.collect() .take(n) .first() .unique() .count() .exists()` | terminals                                                                                                                                                            |
| `.sum(f) .avg(f) .min(f) .max(f)`                           | aggregates computed in the backend                                                                                                                                   |
| `.groupBy('role').count()`                                  | one answer row per group, carrying the grouped columns                                                                                                               |
| `.paginate({ limit, cursor, direction, count })`            | keyset pagination over every sort key                                                                                                                                |
| `.watch()` / `.watch({ mode: 'delta', since })`             | a live view of the same query                                                                                                                                        |

## Writing

`insert` · `insertMany` · `upsert(table, match, value)` · `patch` · `replace` · `delete` ·
`transaction(db => …)`.

Writes are validated against the declared columns, stamp the system fields and announce a change.
`patch`/`replace`/`delete` take `{ ifVersion }` for optimistic concurrency (`db.conflict` when the
row moved on), and `CLEAR` nulls an optional column: `db.patch('users', id, { age: CLEAR })`.

## Reacting

- `db.watch(table, id)` — one document, re-emitted on every change to it
- `query.watch()` — the whole result, recomputed when a change could have moved a row in or out
  (changes that provably cannot are skipped without a query)
- `query.watch({ mode: 'delta', since })` — added/changed/removed instead of snapshots, resuming
  from a token
- `db.changes(table?)` — the raw change feed

Every committed write also lands in a hidden per-table change log, which is what lets a watcher
resume from a `since` token and what a peer replays after a missed message. Install `DbBus` over a
`@ozaco/transport` transport and the changes cross process boundaries.

## Untrusted input

`sanitizeFilter(filter, policy)` checks a wire-supplied filter against a field allowlist, an
operator allowlist and depth/size caps; `clampLimit(value, max)` does the same for a page size.
Both answer `db.validation` rather than passing anything through.

## Subpaths

|                                             |                                                                                    |
| ------------------------------------------- | ---------------------------------------------------------------------------------- |
| `@ozaco/db`                                 | everything above                                                                   |
| `@ozaco/db/impl/{memory,sqlite,pg,bun-sql}` | the database bindings                                                              |
| `@ozaco/db/impl/{memory-kv,redis-kv}`       | the `Kv` stores                                                                    |
| `@ozaco/db/internal`                        | the plumbing an adapter or a Kv store is built on — reach in only when writing one |
