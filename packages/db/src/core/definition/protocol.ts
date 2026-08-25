import type { Operation } from 'std:effect'
import type { Protocol } from 'std:plugin'
import { defineProtocol } from 'std:plugin'
import { fail } from 'std:result'

import pkg from '../../../package.json'
import { DATABASE, DATABASE_ADAPTER, KV_STORE } from '../const'
import { DbErrors } from '../errors'
import type { Adapter } from '../types/adapter'
import type { Database } from '../types/database'
import type { KvDef } from '../types/kv'

/**
 * The app-facing database protocol. Install an adapter, then {@link DbClient}; resolve the typed
 * {@link Database.Handle} anywhere with `useDb(...)`. `Db.actions` carries the management plane
 * (migrations, imperative DDL, bus wiring, the `raw` escape hatch).
 */
export const Db = defineProtocol<Database.Context, Database.Actions>({
  name: 'db',
  version: pkg.version,
  description: 'Reactive, adapter-agnostic database plugin',

  cloneable: true,
  subtype: DATABASE,
})

/**
 * The database+driver binding protocol. Each backend lives in its own module (`db:impl/{memory,
 * sqlite,pg,bun-sql,…}`) and statically imports ONLY its own driver package. An adapter receives
 * portable operation specs (never SQL text), owns all storage en/decoding + dialect knowledge,
 * and classifies backend errors into `DbErrors` tags. Cloneable: several adapters may share a
 * scope — a `DbClient` dispatches to the most recently installed one unless pinned via
 * `Database.Options.adapter`.
 *
 * Middleware belongs here: `DbAdapter.around({ find: … })` wraps every read the handle performs.
 */
export const DbAdapter = defineProtocol<Adapter.Options, Adapter.Actions>({
  name: 'db-adapter',
  version: pkg.version,
  description: 'Structured database adapter: portable specs in, decoded documents out',

  cloneable: true,
  subtype: DATABASE_ADAPTER,

  // capability-gated actions fail cleanly for adapters that omit them; `describe` reads the
  // dispatched impl's context, so no adapter ever implements it
  defaults: {
    *describe(): Operation<Adapter.Options> {
      return yield* (DbAdapter as Protocol<Adapter.Options>).context.expect()
    },
    *transaction() {
      return yield* fail(
        DbErrors.Unsupported,
        'the installed db adapter does not support transactions',
      )
    },
    *raw() {
      return yield* fail(
        DbErrors.Unsupported,
        'the installed db adapter does not support raw statements',
      )
    },
  },
})

/**
 * The key/value store protocol: a namespaced, TTL'd, taggable store over any backend
 * (`db:impl/kv/{memory,redis}`). Cloneable — a memory store and a redis store may share a scope;
 * routed `Kv.actions.*` hit the most recently installed one, a pinned handle
 * (`RedisKvDef.actions.*`) always its own. Impls are thin byte drivers; codec, namespacing,
 * `wrap` singleflight and batch fallbacks are assembled in core by `kvActions`, so middleware
 * (`Kv.around({ get })`) wraps the same code path for every backend.
 */
export const Kv = defineProtocol<KvDef.Options, KvDef.Actions>({
  name: 'kv',
  version: pkg.version,
  description: 'Namespaced key/value store: TTLs, tags, atomic counters, cache-aside wrap',

  cloneable: true,
  subtype: KV_STORE,

  defaults: {
    *describe(): Operation<KvDef.Options> {
      return yield* (Kv as Protocol<KvDef.Options>).context.expect()
    },
  },
})
