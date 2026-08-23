// oxlint-disable import/exports-last
import type { KvDef } from 'db:core'
import { createContext, useContext } from 'std:effect'

import type { MemoryKvDef } from './types'

export const StateRef = createContext<MemoryKvDef.State>('db:impl/kv/memory')

/** A fresh store: `install(MemoryKv, { link })` in every scope that should share it. */
export const createLink = (): MemoryKvDef.Link => ({ entries: new Map(), tags: new Map() })

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** The live entry under a key — an expired one is dropped on the way. */
const live = (link: MemoryKvDef.Link, key: string): MemoryKvDef.Entry | null => {
  const entry = link.entries.get(key)

  if (!entry) {
    return null
  }

  if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
    remove(link, key)
    return null
  }

  return entry
}

const remove = (link: MemoryKvDef.Link, key: string): boolean => {
  const entry = link.entries.get(key)

  if (!entry) {
    return false
  }

  for (const tag of entry.tags) {
    const members = link.tags.get(tag)
    members?.delete(key)

    if (members && members.size === 0) {
      link.tags.delete(tag)
    }
  }

  link.entries.delete(key)

  return true
}

const put = (link: MemoryKvDef.Link, entry: KvDef.RawSet): void => {
  remove(link, entry.key)

  const stored: MemoryKvDef.Entry = {
    data: new Uint8Array(entry.data),
    expiresAt: entry.ttlMs === null ? null : Date.now() + entry.ttlMs,
    tags: new Set(entry.tags),
  }
  link.entries.set(entry.key, stored)

  for (const tag of entry.tags) {
    const members = link.tags.get(tag) ?? new Set<string>()
    members.add(entry.key)
    link.tags.set(tag, members)
  }
}

export const driver: KvDef.Driver = {
  capabilities: { persistent: false, atomic: false, scan: true },

  *get(key) {
    const { link } = yield* useContext(StateRef)
    const entry = live(link, key)

    // copy out: the store must behave like a backend (no shared buffers)
    return entry ? new Uint8Array(entry.data) : null
  },

  *set(entry) {
    put((yield* useContext(StateRef)).link, entry)
  },

  *del(keys) {
    const { link } = yield* useContext(StateRef)
    let removed = 0

    for (const key of keys) {
      if (live(link, key) && remove(link, key)) {
        removed += 1
      }
    }

    return removed
  },

  *has(key) {
    return live((yield* useContext(StateRef)).link, key) !== null
  },

  *ttl(key) {
    const entry = live((yield* useContext(StateRef)).link, key)
    return entry?.expiresAt === null || entry === null
      ? null
      : Math.max(0, entry.expiresAt - Date.now())
  },

  *expire(key, ttlMs) {
    const entry = live((yield* useContext(StateRef)).link, key)

    if (!entry) {
      return false
    }

    entry.expiresAt = Date.now() + ttlMs

    return true
  },

  *incr(key, by, ttlMs) {
    const { link } = yield* useContext(StateRef)
    const entry = live(link, key)
    const current = entry ? Number(decoder.decode(entry.data)) : 0
    const next = (Number.isFinite(current) ? current : 0) + by

    if (entry) {
      link.entries.set(key, { ...entry, data: encoder.encode(String(next)) })
    } else {
      put(link, { key, data: encoder.encode(String(next)), ttlMs, tags: [] })
    }

    return next
  },

  *keys(prefix, options) {
    const { link } = yield* useContext(StateRef)
    const all = [...link.entries.keys()]
      .filter(key => key.startsWith(prefix) && live(link, key) !== null)
      .toSorted()
    const start = options.cursor === undefined ? 0 : all.indexOf(options.cursor) + 1
    const page = all.slice(start, start + options.limit)
    const last = page.at(-1)

    return {
      keys: page,
      cursor: last !== undefined && start + page.length < all.length ? last : null,
    }
  },

  *invalidate(tags) {
    const { link } = yield* useContext(StateRef)
    let removed = 0

    for (const tag of tags) {
      for (const key of Array.from(link.tags.get(tag) ?? [])) {
        if (remove(link, key)) {
          removed += 1
        }
      }

      link.tags.delete(tag)
    }

    return removed
  },

  *clear(prefix) {
    const { link } = yield* useContext(StateRef)
    let removed = 0

    for (const key of Array.from(link.entries.keys())) {
      if (key.startsWith(prefix) && remove(link, key)) {
        removed += 1
      }
    }

    return removed
  },
}
