import type { Operation } from 'std:effect'

/** The context an access guard receives. `op` is the function name (branch on it). Runs in the action
 * scope, so `yield* useDatabase()` / `useAuth()` are available — no injected db. */
export interface AccessContext {
  readonly op: string
  readonly namespace: string
  readonly args: Record<string, unknown>
}

export type AccessGuard = (ctx: AccessContext) => boolean | Operation<boolean>
