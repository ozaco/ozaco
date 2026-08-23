import type { KvDef } from 'db:core'
import { DEFAULT_KV_PREFIX, isValidKvPrefix, Kv, kvActions, kvDefaults, KvErrors } from 'db:core'
import { hasCodec } from 'std:codec'
import { install } from 'std:plugin'
import { fail } from 'std:result'

import { JsonCodec } from 'std:codec/impl/json'

import { createLink, driver, StateRef } from './internal'
import type { MemoryKvDef } from './types'

/**
 * The in-process Kv store — the reference `Kv` implementation and the test double for a shared
 * backend: installs sharing one {@link MemoryKvDef.Link} see the same keys (TTLs, tags, counters,
 * scans). Nothing survives the process. `JsonCodec` is installed unless the scope has a codec.
 */
export const MemoryKv: KvDef.Handle = Kv.implement<KvDef.Options, [options?: MemoryKvDef.Options]>({
  name: 'kv-memory',
  version: '0.1.0',
  description: 'In-process key/value store',

  *setup(options) {
    if (!(yield* hasCodec())) {
      yield* install(JsonCodec)
    }
    const prefix = options?.prefix ?? DEFAULT_KV_PREFIX
    if (!isValidKvPrefix(prefix)) {
      return yield* fail(KvErrors.Configuration, `invalid kv prefix "${prefix}"`)
    }
    yield* StateRef.set({ link: options?.link ?? createLink() })
    return { store: 'memory', prefix, capabilities: driver.capabilities }
  },
}).build({
  ...kvDefaults(),
  ...kvActions(driver),
})

/** A fresh shared store for {@link MemoryKv} installs. */
export { createLink as createMemoryKv } from './internal'
