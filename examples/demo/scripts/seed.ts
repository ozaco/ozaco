import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

/**
 * Mock data: seed N todos into a demo sqlite file (batched inserts inside transactions, so the
 * change log and the events flush per batch, not per row).
 *
 *   bun run scripts/seed.ts [count] [dbPath]     # defaults: 1_000_000, local/demo.sqlite
 *   moon run demo:seed                           # same defaults
 *
 * Then point the demo at it:  DB_PATH=local/demo.sqlite moon run demo:start
 */
import { DbClient } from 'db:core'
import { run } from 'std:effect'
import { unwrap } from 'std:result'

import { SqliteAdapter } from 'db:impl/sqlite'
import { BunIO } from 'std:io/impl/bun'

import { tables } from '../src/tables'

const count = Number(process.argv[2] ?? 1_000_000)
const path = resolve(import.meta.dir, '..', process.argv[3] ?? 'local/demo.sqlite')
const BATCH = 2000

const VERBS = ['write', 'review', 'ship', 'refactor', 'test', 'deploy', 'document', 'design']
const NOUNS = ['the api', 'the panel', 'the docs', 'the pipeline', 'the schema', 'the release']
const PRIORITY_WHEEL = [
  'high',
  'normal',
  'normal',
  'low',
  'normal',
  'low',
  'normal',
  'high',
  'normal',
  'low',
] as const

const todoAt = (index: number) => ({
  title: `${VERBS[index % VERBS.length]} ${NOUNS[((index / VERBS.length) % NOUNS.length) | 0]} #${index}`,
  done: index % 5 < 2,
  priority: PRIORITY_WHEEL[index % PRIORITY_WHEEL.length]!,
})

mkdirSync(dirname(path), { recursive: true })
console.log(`seeding ${count.toLocaleString()} todos into ${path}`)
const startedAt = Date.now()

unwrap(
  await run(function* () {
    yield* BunIO.use()
    yield* SqliteAdapter.use({ path })
    const db = yield* DbClient.use({ tables: [...tables] })

    for (let at = 0; at < count; at += BATCH) {
      const size = Math.min(BATCH, count - at)
      const rows = Array.from({ length: size }, (_, index) => todoAt(at + index))

      yield* db.transaction(tx => tx.insertMany('todos', rows))

      if ((at + size) % 100_000 === 0 || at + size === count) {
        const seconds = (Date.now() - startedAt) / 1000
        const rate = Math.round((at + size) / seconds)
        console.log(
          `  ${(at + size).toLocaleString()} rows · ${seconds.toFixed(1)}s · ${rate.toLocaleString()}/s`,
        )
      }
    }

    const page = yield* db.query('todos').paginate({ limit: 1, count: true })
    console.log(`done — the table now holds ${page.total?.toLocaleString()} todos`)
  }),
)
