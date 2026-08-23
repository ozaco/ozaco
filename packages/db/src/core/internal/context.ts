import { createContext } from 'std:effect'

import type { Change } from '../types/change'
import type { Database } from '../types/database'

export const StateRef = createContext<Database.State>('db:state')

/** The transaction isolation buffer — set for the duration of a `transaction` body. */
export const TxBuffer = createContext<Change.Write[]>('db:tx-buffer')

/** Correlation data attached to every envelope shipped from within `withBusMeta(...)`. */
export const BusMeta = createContext<Readonly<Record<string, unknown>>>('db:bus-meta')
