import { createContext } from 'std:effect'

import type { ObservePluginDef } from '../types/observe'

export const StateRef = createContext<ObservePluginDef.State>('server:plugins/observe')

export const DAY_MS = 24 * 60 * 60 * 1000

/** The most one forwarded `_observe.batch` message carries, serialized (its JSON payload): half
 * NATS' default 1 MB `max_payload`, so the carrier's envelope and headers always fit around it. */
export const MAX_FORWARD_BYTES = 512 * 1024
