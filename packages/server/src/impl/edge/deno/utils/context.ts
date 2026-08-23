import type { Context } from 'std:effect'
import { createContext } from 'std:effect'
import type { AnyType } from 'std:shared'

import type { DenoEdgeDef } from '../types'

/**
 * The runtime `DenoEdge` serves through. Defaults to the global `Deno` when present; set it in
 * the installing scope for fakes (`denoImpl.set({ serve, upgradeWebSocket })`).
 */
export const denoImpl: Context<DenoEdgeDef.Runtime | null> =
  createContext<DenoEdgeDef.Runtime | null>(
    'server:impl/edge/deno/runtime',
    ((globalThis as AnyType).Deno as DenoEdgeDef.Runtime | undefined) ?? null,
  )
