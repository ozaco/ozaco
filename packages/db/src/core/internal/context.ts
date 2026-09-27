import { createContext } from 'std:effect'

import type { Change } from '../types/change'
import type { Database } from '../types/database'

export const StateRef = createContext<Database.State>('db:state')

/** The transaction isolation buffer — set for the duration of a `transaction` body. */
export const TxBuffer = createContext<Change.Write[]>('db:tx-buffer')

/** Correlation data attached to every envelope shipped from within `withBusMeta(...)`. */
export const BusMeta = createContext<Readonly<Record<string, unknown>>>('db:bus-meta')

/** The statement texts of the db span in progress — the shared SQL layer appends to it
 * (`noteQuery`); `null` outside a recording data-plane span. */
export const QueryText = createContext<string[] | null>('db:trace.query-text', null)

/** Set while a Kv op span runs: the adapter calls a store makes (a `TableKv`'s backing table)
 * open no db spans of their own. */
export const InKv = createContext<boolean>('db:trace.in-kv', false)
