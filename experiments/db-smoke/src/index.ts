import { DB } from '@ozaco/db'
import { SqliteDB } from '@ozaco/db/impl/sqlite'
import { col, defineSchema, defineTable } from '@ozaco/db/schema'
import { run, useContext } from '@ozaco/std/effect'
import { install } from '@ozaco/std/plugin'
import { isFailure, isSuccess, unwrap } from '@ozaco/std/result'

const users = defineTable('users', {
  id: col.int().primary().autoIncrement(),
  email: col.text().unique(),
  name: col.text(),
})

const schema = defineSchema({ users })

let failures = 0

const check = (name: string, condition: boolean, detail?: unknown) => {
  if (condition) {
    console.log(`  PASS  ${name}`)
  } else {
    console.error(`  FAIL  ${name}`, detail ?? '')
    failures += 1
  }
}

console.log('\n▶ insert + select + useContext(DB)')
const crudResult = await run(function* () {
  yield* install(SqliteDB, { url: ':memory:', schema })
  const db = yield* useContext(DB)
  const inserted = yield* db
    .insert(users)
    .values({ email: 'a@b.c', name: 'Alice' })
    .returning()
    .firstOrFail()
  const found = yield* db.from(users).where({ email: 'a@b.c' }).firstOrFail()
  return { inserted, found }
})
check('crud result isSuccess', isSuccess(crudResult), crudResult)
if (isSuccess(crudResult)) {
  const { inserted, found } = unwrap(crudResult)
  check('inserted email matches', inserted.email === 'a@b.c')
  check('found name matches', found.name === 'Alice')
  check('found id matches inserted', found.id === inserted.id)
}

console.log('\n▶ unique-violation classification')
const dupResult = await run(function* () {
  yield* install(SqliteDB, { url: ':memory:', schema })
  const db = yield* useContext(DB)
  yield* db.insert(users).values({ email: 'dup@x.com', name: 'A' }).execute()
  yield* db.insert(users).values({ email: 'dup@x.com', name: 'B' }).execute()
  return 'should-not-reach'
})
check('dup is failure', isFailure(dupResult), dupResult)
if (isFailure(dupResult)) {
  check('error kind is unique-violation', dupResult.error === 'unique-violation')
}

console.log('\n▶ migration: add column on schema evolution')
const url = `file:/tmp/ozaco-db-smoke-${Date.now()}.sqlite`
const usersV1 = defineTable('users_mig', {
  id: col.int().primary().autoIncrement(),
  email: col.text().unique(),
})
const v1 = defineSchema({ users_mig: usersV1 })
const first = await run(function* () {
  yield* install(SqliteDB, { url, schema: v1 })
  const db = yield* useContext(DB)
  yield* db.insert(usersV1).values({ email: 'x@y.z' }).execute()
  return yield* db.from(usersV1).all()
})
check('v1 insert success', isSuccess(first), first)

const usersV2 = defineTable('users_mig', {
  id: col.int().primary().autoIncrement(),
  email: col.text().unique(),
  name: col.text().optional(),
})
const v2 = defineSchema({ users_mig: usersV2 })
const second = await run(function* () {
  yield* install(SqliteDB, { url, schema: v2 })
  const db = yield* useContext(DB)
  yield* db.update(usersV2).set({ name: 'Added' }).where({ email: 'x@y.z' }).execute()
  return yield* db.from(usersV2).firstOrFail()
})
check('v2 migration success', isSuccess(second), second)
if (isSuccess(second)) {
  const row = unwrap(second) as { id: number; email: string; name: string | null }
  check('migrated row has new column value', row.name === 'Added')
  check('migrated row preserves email', row.email === 'x@y.z')
}

console.log('\n▶ transaction rollback on failure')
const txResult = await run(function* () {
  yield* install(SqliteDB, { url: ':memory:', schema })
  const db = yield* useContext(DB)
  yield* db.insert(users).values({ email: 'first@x.com', name: 'First' }).execute()
  const outcome = yield* (function* () {
    try {
      yield* db.transaction(function* (tx) {
        yield* tx.insert(users).values({ email: 'second@x.com', name: 'Second' }).execute()
        yield* tx.insert(users).values({ email: 'first@x.com', name: 'Dup' }).execute()
        return null
      })
      return 'tx-ok' as const
    } catch {
      return 'tx-err' as const
    }
  })()
  const rows = yield* db.from(users).all()
  return { outcome, rows }
})
check('tx result isSuccess', isSuccess(txResult), txResult)
if (isSuccess(txResult)) {
  const { outcome, rows } = unwrap(txResult)
  check('tx threw (outcome=tx-err)', outcome === 'tx-err')
  check('only 1 row after rollback', rows.length === 1)
  check('remaining row is first', rows[0]?.email === 'first@x.com')
}

if (failures > 0) {
  throw new Error(`${failures} check(s) failed`)
}

console.log('\n✓ all checks passed')
