import { createContext } from 'std:effect'
import type { AnyType } from 'std:shared'

import type { WsDef } from './types'

/**
 * The WebSocket implementation `connect()` dispatches through. Defaults to the platform global
 * `WebSocket`; override it (tests, a loopback socket, a custom transport) with `wsImpl.set(Ctor)` or
 * `wsImpl.with(Ctor, op)` in the running scope. Read via `wsImpl.get()` so the default applies unset.
 */
export const wsImpl = createContext<WsDef.Ctor>(
  'std:ws',
  (globalThis as AnyType).WebSocket as WsDef.Ctor,
)
