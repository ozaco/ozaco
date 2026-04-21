import { operation } from 'std:effect'

import type { AuthProvider, AuthUser } from '../types'

export const collectAuthz = operation(function* (provider: AuthProvider, user: AuthUser) {
  const roles = provider.getRoles ? ((yield* provider.getRoles(user)) ?? []) : []
  const permissions = provider.getPermissions ? ((yield* provider.getPermissions(user)) ?? []) : []
  return { roles, permissions }
})
