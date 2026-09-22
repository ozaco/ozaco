// oxlint-disable import/exports-last
import type { KvDef, Spec } from 'db:core'
import { DbAdapter, FIELDS, VERSION_ZERO, where } from 'db:core'
import type { Operation } from 'std:effect'
import { createContext, until, useContext } from 'std:effect'
import type { AnyType } from 'std:shared'

import type { TableKvDef } from './types'

export const StateRef = createContext<TableKvDef.State>('db:impl/table-kv')

/** Tag rows are keyed `<tag><US><key>` — the ASCII unit separator (0x1F) is valid text on every
 * backend (Postgres refuses NUL) and never appears in a tag or a key, so the pair is a
 * collision-free primary key and `startsWith(tag + US)` lists one tag's members. */
const SEPARATOR = '\u001F'

export const createLock = (): TableKvDef.Lock => {
  const waiters: Array<() => void> = []
  let held = false

  const release = (): void => {
    const next = waiters.shift()

    if (next) {
      next() // straight to the next waiter; the lock stays held
      return
    }

    held = false
  }

  return {
    *acquire() {
      if (!held) {
        held = true
        return release
      }

      yield* until(
        new Promise<void>(resolve => {
          waiters.push(resolve)
        }),
      )

      return release
    },
  }
}

// --- bytes ↔ text ------------------------------------------------------------------------------

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** Base64 without `Buffer` (Bun/Node have it, a web runtime does not). */
const toBase64 = (bytes: Uint8Array): string => {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64')
  }

  let binary = ''

  for (const byte of bytes) {
    binary += String.fromCodePoint(byte)
  }

  return btoa(binary)
}

const fromBase64 = (text: string): Uint8Array => {
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(text, 'base64'))
  }

  return Uint8Array.from(atob(text), char => char.codePointAt(0)!)
}

// --- rows --------------------------------------------------------------------------------------

interface Row {
  readonly _id: string
  readonly data: string
  readonly expires_at: number | null
  readonly tags: readonly string[]
}

const now = (): number => Date.now()

/** A stored row is live while it has no deadline or the deadline is ahead. */
const liveFilter = (): Spec.Filter =>
  where.or(where.isNull('expires_at'), where.gt('expires_at', now()))

const stamp = (id: string, fields: Record<string, unknown>): Spec.Doc => {
  const at = now()

  return {
    [FIELDS.id]: id,
    [FIELDS.created]: at,
    [FIELDS.updated]: at,
    [FIELDS.version]: VERSION_ZERO,
    ...fields,
  }
}

function* find(table: Spec.Table, filter: Spec.Filter, limit: number | null = null) {
  return (yield* DbAdapter.actions.find({
    table,
    filter,
    order: [{ field: FIELDS.id, direction: 'asc' }],
    limit,
    offset: null,
  })) as readonly AnyType[]
}

function* rowOf(state: TableKvDef.State, key: string): Operation<Row | null> {
  const rows = yield* find(state.entries, where.eq(FIELDS.id, key), 1)
  const row = rows[0] as Row | undefined

  if (!row) {
    return null
  }

  if (row.expires_at !== null && row.expires_at <= now()) {
    // lazy expiry: an expired row is dropped on the way out, tags included
    yield* dropKeys(state, [key])
    return null
  }

  return row
}

/** Remove keys and their tag rows; resolves how many entry rows existed. */
function* dropKeys(state: TableKvDef.State, keys: readonly string[]): Operation<number> {
  if (keys.length === 0) {
    return 0
  }

  const removed = yield* DbAdapter.actions.remove({
    table: state.entries,
    filter: where.oneOf(FIELDS.id, [...keys]),
  })

  const tagIds: string[] = []

  for (const row of removed as unknown as readonly Row[]) {
    for (const tag of row.tags ?? []) {
      tagIds.push(`${tag}${SEPARATOR}${row._id}`)
    }
  }

  if (tagIds.length > 0) {
    yield* DbAdapter.actions.remove({ table: state.tags, filter: where.oneOf(FIELDS.id, tagIds) })
  }

  return removed.length
}

/** Insert-or-update one entry, re-pointing its tag rows. */
function* put(state: TableKvDef.State, entry: KvDef.RawSet): Operation<void> {
  const fields = {
    data: toBase64(entry.data),
    expires_at: entry.ttlMs === null ? null : now() + entry.ttlMs,
    tags: [...entry.tags],
  }

  yield* DbAdapter.actions.transaction(function* () {
    const existing = (yield* find(state.entries, where.eq(FIELDS.id, entry.key), 1))[0] as
      | Row
      | undefined

    if (existing) {
      // the old tag memberships go: a re-set key carries ONLY its new tags
      const stale = (existing.tags ?? []).map(tag => `${tag}${SEPARATOR}${entry.key}`)

      if (stale.length > 0) {
        yield* DbAdapter.actions.remove({
          table: state.tags,
          filter: where.oneOf(FIELDS.id, stale),
        })
      }

      yield* DbAdapter.actions.update({
        table: state.entries,
        filter: where.eq(FIELDS.id, entry.key),
        set: { ...fields, [FIELDS.updated]: now() },
      })
    } else {
      yield* DbAdapter.actions.insert(state.entries, [stamp(entry.key, fields)])
    }

    if (entry.tags.length > 0) {
      yield* DbAdapter.actions.insert(
        state.tags,
        entry.tags.map(tag => stamp(`${tag}${SEPARATOR}${entry.key}`, { tag, key: entry.key })),
      )
    }
  })
}

export const driver: KvDef.Driver = {
  // rows outlive the process wherever the adapter does; the counter lock is in-process only
  capabilities: { persistent: true, atomic: false, scan: true },

  *get(key) {
    const row = yield* rowOf(yield* useContext(StateRef), key)
    return row ? fromBase64(row.data) : null
  },

  *set(entry) {
    yield* put(yield* useContext(StateRef), entry)
  },

  *del(keys) {
    const state = yield* useContext(StateRef)
    const live: string[] = []

    for (const key of keys) {
      if (yield* rowOf(state, key)) {
        live.push(key)
      }
    }

    return yield* dropKeys(state, live)
  },

  *has(key) {
    return (yield* rowOf(yield* useContext(StateRef), key)) !== null
  },

  *ttl(key) {
    const row = yield* rowOf(yield* useContext(StateRef), key)
    return row === null || row.expires_at === null ? null : Math.max(0, row.expires_at - now())
  },

  *expire(key, ttlMs) {
    const state = yield* useContext(StateRef)

    if (!(yield* rowOf(state, key))) {
      return false
    }

    yield* DbAdapter.actions.update({
      table: state.entries,
      filter: where.eq(FIELDS.id, key),
      set: { expires_at: now() + ttlMs, [FIELDS.updated]: now() },
    })

    return true
  },

  *incr(key, by, ttlMs) {
    const state = yield* useContext(StateRef)
    const release = yield* state.lock.acquire()

    try {
      const row = yield* rowOf(state, key)
      const current = row ? Number(decoder.decode(fromBase64(row.data))) : 0
      const next = (Number.isFinite(current) ? current : 0) + by

      const data = encoder.encode(String(next))

      yield* row
        ? DbAdapter.actions.update({
            table: state.entries,
            filter: where.eq(FIELDS.id, key),
            set: { data: toBase64(data), [FIELDS.updated]: now() },
          })
        : put(state, { key, data, ttlMs, tags: [] })

      return next
    } finally {
      release()
    }
  },

  *keys(prefix, options) {
    const state = yield* useContext(StateRef)
    const bounds: Spec.Filter[] = [where.startsWith(FIELDS.id, prefix), liveFilter()]

    if (options.cursor !== undefined) {
      bounds.push(where.gt(FIELDS.id, options.cursor))
    }

    // one row past the page tells whether a next page exists
    const page = yield* find(state.entries, where.and(...bounds), options.limit + 1)
    const keys = page.slice(0, options.limit).map((row: Row) => row._id)
    const last = keys.at(-1)

    return { keys, cursor: page.length > options.limit && last !== undefined ? last : null }
  },

  *invalidate(tags) {
    const state = yield* useContext(StateRef)
    const keys = new Set<string>()

    for (const tag of tags) {
      const members = yield* find(state.tags, where.startsWith(FIELDS.id, `${tag}${SEPARATOR}`))

      for (const member of members) {
        keys.add(String(member.key))
      }
    }

    return yield* dropKeys(state, [...keys])
  },

  *clear(prefix) {
    const state = yield* useContext(StateRef)
    const rows = yield* find(state.entries, where.startsWith(FIELDS.id, prefix))

    return yield* dropKeys(
      state,
      rows.map((row: Row) => row._id),
    )
  },
}
