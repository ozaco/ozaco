import type { Operation } from 'std:effect'

import type { Meta } from './common'
import type { EdgeRequest } from './gateway'

/** The resolved caller identity an auth strategy produces. */
export interface Principal {
  readonly sub: string
  readonly roles: readonly string[]
  readonly permissions: readonly string[]
  readonly claims: Record<string, unknown>
}

/**
 * The strategy seam (impls land in `server:auth`: access-refresh, jwt-session). Defined in core so
 * hooks and gateway upgrade guards can type against it before any strategy is installed.
 */
export interface AuthStrategyActions {
  /** Resolve the caller from request meta (authorization header, promoted `?token=` …). */
  authorize(meta: Meta): Operation<Principal>
  hasRole(principal: Principal, role: string): Operation<boolean>
  hasPermission(principal: Principal, permission: string): Operation<boolean>
  /** The caller of the CURRENT request (in-handler); fails `Unauthorized` — 401 at the edge. */
  user(): Operation<Principal>
  /** Mint a service-to-service token: `sub` is `service:<name>`, trusted without a user lookup. */
  signServiceToken(serviceName: string, ttlMs?: number): Operation<string>
  /** Build a `SocketRoute.authorize`-compatible upgrade guard bound to this strategy. */
  authorizeSocket(): Operation<(request: EdgeRequest) => Operation<boolean>>
}
