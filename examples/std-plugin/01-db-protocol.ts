/**
 * Basics: define a protocol, implement it, install it, call it.
 *
 * The plugin system sits on top of std:effect's api layer. A protocol's actions live under
 * `.actions`, mirroring the api layer — `Db.actions.find(1)`.
 *
 * Run: bun run examples/std-plugin/01-db-protocol.ts
 */
import type { Operation } from 'std:effect'
import { run, useContext } from 'std:effect'
import { defineProtocol, install } from 'std:plugin'
import { isFailure, unwrap } from 'std:result'

interface DbContext {
  rows: Map<number, string>
}

interface DbActions {
  find(id: number): Operation<string | undefined>
  put(id: number, row: string): Operation<void>
}

// 1. the contract — no implementation yet
const Db = defineProtocol<DbContext, DbActions>({
  name: 'db',
  version: '1.0.0',
})

// 2. an implementation: `setup` produces the impl's context value; `build` provides the actions
const MemoryDb = Db.implement({
  name: 'memory-db',
  version: '1.0.0',
  *setup(seed?: [number, string][]) {
    return { rows: new Map(seed) }
  },
}).build({
  *find(id) {
    // during an action the protocol context holds THIS impl's value
    const ctx = yield* useContext(Db)
    return ctx.rows.get(id)
  },
  *put(id, row) {
    const ctx = yield* useContext(Db)
    ctx.rows.set(id, row)
  },
})

const outcome = await run(function* () {
  // calling before install fails with a `missing-action` Failure
  try {
    yield* Db.actions.find(1)
  } catch (error) {
    if (isFailure(error)) {
      console.log('before install:', String(error.error), '-', error.message)
    }
  }

  // 3. install into the current scope (children inherit it, siblings don't)
  yield* install(MemoryDb, [[1, 'one']])

  // 4. calls through the .actions surface
  yield* Db.actions.put(2, 'two')
  console.log('Db.actions.find(1) =', yield* Db.actions.find(1))
  console.log('Db.actions.find(2) =', yield* Db.actions.find(2))

  // the plugin handle has the same .actions surface, always targeting its own impl
  console.log('MemoryDb.actions.find(1) =', yield* MemoryDb.actions.find(1))

  return 'done'
})

console.log('run outcome:', unwrap(outcome))
