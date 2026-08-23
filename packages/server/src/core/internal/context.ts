import { createContext } from 'std:effect'

import type { Helpers } from '../types/helpers'

/** Private state contexts of the core's own impls (never exported from the barrel). */
export const OutcomesMemoryRef =
  createContext<Helpers.OutcomesMemoryState>('server:outcomes/memory')
export const OutcomesDbRef = createContext<Helpers.OutcomesDbState>('server:outcomes/db')
export const LocalCarrierRef = createContext<Helpers.LocalCarrierState>('server:carrier/local')
