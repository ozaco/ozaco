import { operation } from 'std:effect'

import { DEFAULT_ACCESS_TTL, TOKEN_TYPE_ACCESS } from '../internal/const'
import { parseDuration } from '../internal/helpers'
import { signPrincipalToken } from '../internal/tokens'
import type { AuthDef } from '../types'

export interface ServiceTokenOptions {
  /** Stable service identity — becomes the token's `sub`/`user.id` as `service:<name>`. */
  readonly name: string
  /** Token lifetime (`'15m'`, `'2h'`, ms number). Defaults to the access-token default. */
  readonly ttl?: string | number | undefined
  /** Claims the installed guards authorize against — grant only what the workload needs. */
  readonly roles?: string[] | undefined
  readonly permissions?: string[] | undefined
  /** The token `type` the target strategy expects: `'access'` (access-refresh, default) or
   * `'session'` (jwt-session). */
  readonly type?: 'access' | 'session' | undefined
}

/**
 * Mint a SERVICE token — a first-class principal for workloads that are not a signed-in user
 * (background jobs, execution engines, cluster-internal callers). Signed with the installed auth
 * plugin's key, so `authorize`/`useAuth` accept it like any user token; the subject is namespaced
 * `service:<name>` so guards and audit trails can tell services from users. Pass it as
 * `Broker.actions.call(target, path, sources, { principal: token })` to run a context-less call
 * under this identity.
 */
export const signServiceToken = operation(function* (options: ServiceTokenOptions) {
  const ttlMs = yield* parseDuration(options.ttl ?? DEFAULT_ACCESS_TTL)
  const claims: AuthDef.PrincipalClaims = {
    user: { id: `service:${options.name}` },
    roles: options.roles ?? [],
    permissions: options.permissions ?? [],
  }

  return yield* signPrincipalToken(options.type ?? TOKEN_TYPE_ACCESS, ttlMs, claims)
})
