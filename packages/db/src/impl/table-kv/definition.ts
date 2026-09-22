import type { KvDef } from 'db:core'
import { column, DbAdapter, Kv, KvErrors, table } from 'db:core'
import { DEFAULT_KV_PREFIX, isValidKvPrefix, kvActions, tableSpecOf } from 'db:internal'
import { Codec } from 'std:codec'
import { attempt, useContext } from 'std:effect'
import { fail, isFailure } from 'std:result'

import { JsonCodec } from 'std:codec/impl/json'

import pkg from '../../../package.json'

import { createLock, driver, StateRef } from './internal'
import type { TableKvDef } from './types'

const TABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u

/**
 * A `Kv` store INSIDE the database — `TableKv.use({ prefix, table })` over whatever `DbAdapter`
 * the scope has installed (sqlite for a single-node app, pg/bun-sql for a cluster). Entries are
 * rows of `<table>` (`_id` = the namespaced key, base64 bytes, an epoch-ms deadline, the tag
 * list), tag memberships rows of `<table>_tags`; both are created here, idempotently, and carry
 * no change log — an application `DbClient` on the same adapter never touches them. Values
 * outlive the process with the database; `incr` is serialized in-process only (`atomic: false`).
 * `JsonCodec` is installed unless the scope has a codec.
 */
export const TableKv = Kv.implement<KvDef.Options, [options?: TableKvDef.Options]>({
  name: 'kv-table',
  version: pkg.version,
  description: 'Key/value store over the installed db adapter',

  *setup(options) {
    if (!(yield* Codec.actions.hasCodec())) {
      yield* JsonCodec.use()
    }
    const prefix = options?.prefix ?? DEFAULT_KV_PREFIX
    if (!isValidKvPrefix(prefix)) {
      return yield* fail(KvErrors.Configuration, `invalid kv prefix "${prefix}"`)
    }
    const name = options?.table ?? '_kv'
    if (!TABLE_NAME.test(name)) {
      return yield* fail(KvErrors.Configuration, `invalid kv table name "${name}"`)
    }
    const adapter = yield* attempt(() => useContext(DbAdapter))
    if (isFailure(adapter)) {
      return yield* fail(
        KvErrors.Configuration,
        'no db adapter installed — install a db:impl/* adapter before TableKv',
      )
    }
    const entries = tableSpecOf(
      table(
        name,
        {
          data: column.text(),
          expires_at: column.int().optional(),
          tags: column.json<readonly string[]>(),
        },
        { log: false },
      ),
    )
    const tags = tableSpecOf(
      table(`${name}_tags`, { tag: column.text(), key: column.text() }, { log: false }),
    )
    // the two tables come into being here, idempotently (create steps are IF NOT EXISTS)
    const created = yield* attempt(() =>
      DbAdapter.actions.migrate([
        { kind: 'create-table', table: entries },
        { kind: 'create-table', table: tags },
      ]),
    )
    if (isFailure(created)) {
      return yield* fail(
        KvErrors.Configuration,
        `cannot create kv tables "${name}"`,
        ...created.causes,
      )
    }
    yield* StateRef.set({ entries, tags, lock: createLock() })
    return { store: 'table', prefix, capabilities: driver.capabilities }
  },
}).build(kvActions(driver))
