import { createContext } from 'std:effect'

import type { FetchDef } from './types'

/**
 * The underlying fetch implementation the `Fetch` plugin's `request` dispatch runs through.
 * Defaults to `globalThis.fetch`; override it (tests, SSR, a custom transport) with
 * `fetchImpl.set(impl)` or `fetchImpl.with(impl, op)` in the running scope. Read with
 * `fetchImpl.get()` so the default applies when unset.
 */
export const fetchImpl = createContext<FetchDef.Impl>('std:fetch', (input, init) =>
  globalThis.fetch(input, init),
)
