import { createContext } from 'std:effect'
import type { AnyType } from 'std:shared'

import type { WsDef } from '../types/ws'

/**
 * The WebSocket implementation `connect()` dispatches through. Defaults to the platform global
 * `WebSocket`; override it (tests, a loopback socket, a custom transport) with `wsImpl.set(impl)` or
 * `wsImpl.with(impl, op)` in the running scope. Read via `wsImpl.get()` so the default applies unset.
 */
export const wsImpl = createContext<WsDef.ImplLike>(
  'std:ws',
  (globalThis as AnyType).WebSocket as WsDef.ImplLike,
)
