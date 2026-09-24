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
import { column, DbClient, defineSchema, table, useDb, where } from '@ozaco/db'
import { MemoryAdapter } from '@ozaco/db/impl/memory'
import { main } from '@ozaco/std/effect'
import { BunIO } from '@ozaco/std/io/impl/bun'

const todos = table('todos', {
  title: column.text(),
  done: column.boolean().default(() => false),
  priority: column.enumOf('low', 'normal', 'high').default(() => 'normal'),
})

const schema = defineSchema({ todos })

await main(function* () {
  yield* BunIO.use()
  yield* MemoryAdapter.use()
  yield* DbClient.use({ schema })

  const db = yield* useDb(schema)

  yield* db.insert('todos', { title: 'write the README' })

  const open = yield* db.query('todos').filter(where.eq('done', false)).order('priority').collect()
  //    open[0].title  → string, no cast
})
```

`defineSchema({ ... })` is the ONE declaration: the install takes it and `useDb(schema)` resolves
the typed handle anywhere — no call site re-lists the tables (the argument is type-only; nothing
is read from it at runtime).

## Declaring

```ts
const users = table('users', {
  email: column.text(),
  name: column.text(),
  age: column.int().optional(),
  role: column.enumOf('admin', 'member').default(() => 'member'),
  tags: column.json<readonly string[]>(),
  joined: column.timestamp().optional(), // reads back a Date
  seen: column.timestamp({ as: 'ms' }).optional(), // epoch millis as a number, in and out
  avatar: column.blob().optional(), // raw bytes (Uint8Array): sqlite BLOB / pg BYTEA, no base64
  team: column.id('teams'), //  a text column, branded with the table it points at
})
  .unique('by_email', ['email'])
  .index('by_role', ['role'])
```

`timestamp()` and `timestamp({ as: 'ms' })` are stored the same way (an integer of epoch
millis), so switching a column between them needs no migration — `ms` just keeps the `number`
the system fields use. `_id`, `_created_at`, `_updated_at` and `_version` are implicit on every
row. Schema reconcile runs
at install (`migrations: 'auto'`); `safe: true` skips the destructive steps.

## Reading

|                                                             |                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.where({ role: 'admin' })`                                 | equality shorthand                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `.filter(where.eq('done', false), …)`                       | the portable algebra — `eq ne gt gte lt lte oneOf notOneOf like ilike startsWith isNull notNull and or not` (`startsWith` escapes the prefix; `escapeLike` does it by hand). Field names are checked against the table: a typo does not compile                                                                                                                                                                                                                         |
| `where.eq(['payload', 'workspace'], id)`                    | a PATH into a `json` column — every leaf op takes one (the first entry is the column, checked like any field; later entries are keys or array indexes). sqlite `json_extract`, Postgres `jsonb #>`, memory walks the value. Type-strict everywhere: a number only meets numbers, a string strings, a boolean booleans (a `Date` compares as epoch ms); a missing key and JSON `null` are both null. Only `json` columns can be reached into (`db.validation` otherwise) |
| `.order('priority', 'desc').order('title')`                 | sort keys **stack**, `_id` closes them as a tiebreak                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `.select('title', 'size')`                                  | read only these columns (the system fields ride along, so paging and watching keep working)                                                                                                                                                                                                                                                                                                                                                                             |
| `.collect() .take(n) .first() .unique() .count() .exists()` | terminals                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `.sum(f) .avg(f) .min(f) .max(f)`                           | aggregates computed in the backend                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `.groupBy('role').count()`                                  | one answer row per group, carrying the grouped columns                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `.skip(n)`                                                  | skip the first `n` rows (SQL `OFFSET`) of `collect`/`take`/`first`/`unique`/`exists`/`watch`; `count`, aggregates and `paginate` ignore it. Without an `order` the window follows `_created_at`, `_id`. Calls replace                                                                                                                                                                                                                                                   |
| `.paginate({ limit, cursor, direction, count })`            | keyset pagination over every sort key → `{ data, pageInfo, total?, token }` — stable under concurrent writes (feeds, infinite scroll)                                                                                                                                                                                                                                                                                                                                   |
| `.paginate({ page, pageSize })`                             | offset pagination → `{ rows, total, page, pages, pageSize, token }`, `page` 1-based — numbered pages (admin tables); one COUNT + one windowed read. The two forms are told apart by `page` vs `limit`                                                                                                                                                                                                                                                                   |
| `.watch()` / `.watch({ mode: 'delta', since })`             | a live view of the same query                                                                                                                                                                                                                                                                                                                                                                                                                                           |

## Writing

`insert` · `insertMany` · `upsert(table, match, value, options?)` · `insertOrIgnore` · `import` ·
`patch` · `replace` · `delete` · `transaction(db => …)`.

Writes are validated against the declared columns, stamp the system fields and announce a change.
`patch`/`replace`/`delete`/`upsert` take `{ ifVersion }` for optimistic concurrency
(`db.conflict` when the row moved on), and `CLEAR` nulls an optional column:
`db.patch('users', id, { age: CLEAR })`.

**Upsert** runs as one transaction; if a concurrent upsert inserts the same key first, the loser's
`db.unique` is retried once as the update it now is — declare a unique index over the `match`
columns so the backend can tell. Add `when` to guard the update branch:

```ts
// insert if absent; re-arm only once the existing row has finished; otherwise leave it alone
const { op, doc } =
  yield *
  db.upsert(
    'jobs',
    { key },
    { state: 'queued' },
    {
      when: where.oneOf('state', ['done', 'dead']),
    },
  )
// op: 'inserted' | 'updated' | 'skipped' ('skipped' → doc is the untouched existing row)
```

The `when` predicate joins the guarded `UPDATE` itself, so a row that moved on concurrently is
never updated past it.

`insertOrIgnore(table, value)` answers `null` instead of failing `db.unique` (it runs as its own
nested transaction, so an enclosing Postgres transaction stays usable).

**Moving rows between databases.** `insert` always stamps fresh system fields. `import(table,
rows)` keeps them: `_id` (required), `_created_at`/`_updated_at` (non-negative integer ms) and
`_version` (a change token) are validated and preserved — missing ones are stamped as on insert —
while the columns are validated like an insert. Each row is announced as an `insert` with a FRESH
change token (the change is new to this database). `stripSystem(row)` is the opposite: a copy
without `_id`/`_created_at`/`_updated_at`/`_version`, ready to `insert` under a new identity.

## Scoping (tenancy)

`db.scoped(where.eq('tenant', id))` derives a handle whose EVERY operation runs under that
trusted predicate: reads and watches see only matching rows, guarded writes MISS (never
conflict) outside it, and inserts are STAMPED with the values the filter pins — a scoped handle
cannot write outside its own scope. Calls chain (`AND`), transactions inherit the scope, and the
per-call form (`{ scope }` on `get`/`patch`/`replace`/`delete`/`upsert`/`watch`) composes with
it.

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

## Job queue (`@ozaco/db/queue`)

A durable queue whose jobs are rows of a table in the same database — they survive restarts,
work on every adapter, and can be enqueued inside the transaction that decided them.

```ts
import { Queue, queueTable } from '@ozaco/db/queue'

const jobs = queueTable('jobs')
const schema = defineSchema({ users, jobs })

yield * DbClient.use({ schema })
yield * Queue.use({ table: 'jobs' })

yield * Queue.actions.enqueue('email', { to: 'ada' }, { dedupeKey: 'welcome:ada', priority: 5 })

const worker =
  yield *
  Queue.actions.work(
    {
      *email(job) {
        yield* send(job.payload) // fail (or throw) → retry with backoff, then the dead letter
      },
    },
    { batch: 4, maxAttempts: 5, backoff: { kind: 'exponential', baseMs: 1000 }, pollMs: 1000 },
  )
```

- **States:** `queued → running → done`; a failed attempt goes to `failed` (claimable again once
  its backoff `run_at` is due) or, out of attempts, to `dead`. `Queue.actions.retry(id)` revives a
  `dead`/`failed` job; `counts()` answers per state; `get(id)` reads one.
- **`enqueue(kind, payload?, { dedupeKey?, runAt?, priority?, maxAttempts? })`** →
  `{ op, job }`. With a `dedupeKey` there is one LIVE job per key: `skipped` while it is
  queued/running/failed, re-armed (`updated`, same row, attempts reset) once it is done/dead —
  the guarded `upsert(…, { when })`, atomic on every adapter.
- **`work(handlers, { batch, backoff, maxAttempts, pollMs, leaseMs, sweepMs })`** starts a worker
  in the current scope and returns `{ id, stats(), halt() }`. It claims only the kinds it has
  handlers for, highest `priority` first; every claim is ONE guarded update (`_version` + a
  claimable state), so any number of workers in any number of processes never run the same
  attempt twice. It wakes on the table's change feed (local writes, and the `DbBus` across
  nodes) and otherwise polls at most `pollMs` apart — sooner when a `runAt` comes due.
- **Leases:** a running job holds a lease (`leaseMs`, default 30s) its worker renews every
  `leaseMs / 3`; every worker sweeps lapsed leases (a crashed process) back to `failed` (or
  `dead`). The writes that settle an attempt are guarded by (worker, attempt), so a worker that
  lost its lease cannot overwrite the job's newer state.
- **Halting:** the worker halts with its scope (or `worker.halt()`); in-flight jobs are handed
  back to `queued` with the interrupted attempt uncounted.
- `backoff` is `{ kind: 'exponential', baseMs?, maxMs? }`, `{ kind: 'linear', stepMs?, maxMs? }`
  or `(attempt) => ms`. Failures are tagged `QueueErrors` (`db:queue.configuration` /
  `db:queue.validation`); a handler's failure is recorded on the job (`last_error`), never
  surfaced.

## Untrusted input

`sanitizeFilter(filter, policy)` checks a wire-supplied filter against a field allowlist, an
operator allowlist and depth/size caps (a json `path` is allowed on an allowed field, its
segments checked); `clampLimit(value, max)` does the same for a page size.
Both answer `db.validation` rather than passing anything through.

## Subpaths

|                                                |                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@ozaco/db`                                    | everything above                                                                                                                                                                                                                                                                                                                                           |
| `@ozaco/db/impl/{memory,sqlite,pg,bun-sql}`    | the database bindings                                                                                                                                                                                                                                                                                                                                      |
| `@ozaco/db/impl/{memory-kv,redis-kv,table-kv}` | the `Kv` stores — `TableKv` keeps them as rows of the installed adapter (persistent sqlite/pg cache without a redis)                                                                                                                                                                                                                                       |
| `@ozaco/db/queue`                              | the durable job queue (`Queue`, `queueTable`, `QueueErrors`)                                                                                                                                                                                                                                                                                               |
| `@ozaco/db/adapter-kit`                        | the stable surface a THIRD-PARTY adapter is built from: `adapterDefaults`, and the in-memory evaluators for what a backend cannot do natively — `matches` (the filter algebra, json paths included), `sortDocs`, `aggregateDocs` (the aggregate plane: groups + count/sum/avg/min/max) — plus `filterFields`/`filterPaths`, `isSystemField`, `tableSpecOf` |
| `@ozaco/db/testing`                            | the adapter conformance suite: `runAdapterSuite({ label, enabled, raw, use })` under `bun test` (it imports `bun:test` — test files only)                                                                                                                                                                                                                  |
| `@ozaco/db/internal`                           | the plumbing an adapter or a Kv store is built on — reach in only when writing one                                                                                                                                                                                                                                                                         |

## Writing an adapter

Implement `DbAdapter` with `@ozaco/db/adapter-kit` and prove it with the same suite the built-in
adapters run:

```ts
// my-adapter.test.ts
import { runAdapterSuite } from '@ozaco/db/testing'

runAdapterSuite({ label: 'mine', enabled: true, raw: false, use: () => MyAdapter.use() })
```

`label` must equal the adapter's `info.adapter`; `raw: true` also runs the SQL `raw` tests.
