import { ServerErrors } from 'server:core'
import { fail } from 'std:result'

import pkg from '../../../../package.json'
import { AuthStrategy } from '../definition'
import type { AuthDef } from '../types'

const StaticAuthImpl = AuthStrategy.implement<
  AuthDef.StaticContext,
  [options: AuthDef.StaticOptions]
>({
  name: 'server-auth-static',
  version: pkg.version,
  description: 'Pre-shared bearer tokens from config',

  *setup(given) {
    const tokens = new Map<string, AuthDef.Principal>()

    for (const [token, principal] of Object.entries(given?.tokens ?? {})) {
      if (token.trim() === '') {
        return yield* fail(ServerErrors.Configuration, 'auth: a static token must not be empty')
      }
      if (typeof principal?.sub !== 'string' || principal.sub === '') {
        return yield* fail(ServerErrors.Configuration, 'auth: every static token needs a `sub`')
      }
      tokens.set(token, {
        sub: principal.sub,
        type: principal.type ?? 'session',
        roles: principal.roles ?? [],
        permissions: principal.permissions ?? [],
        claims: principal.claims ?? {},
        jti: `static:${principal.sub}`,
      })
    }
    if (tokens.size === 0) {
      return yield* fail(
        ServerErrors.Configuration,
        'StaticAuth needs tokens — StaticAuth.use({ tokens: { "<token>": { sub } } })',
      )
    }
    return { strategy: 'static', tokens }
  },
})

/**
 * The static-token strategy — `StaticAuth.use({ tokens: { '<token>': { sub, roles, type } } })`:
 * opaque pre-shared bearers (an MCP host, a cron, a UI behind a reverse proxy) looked up
 * verbatim; anything else is "not mine". It never issues tokens — pair it with `JwtAuth` when
 * users must log in.
 */
export const StaticAuth = StaticAuthImpl.build({
  *verify(token: string) {
    return (yield* StaticAuthImpl.context.expect()).tokens.get(token)
  },

  // static tokens are configured, never issued — every minting call is "not mine"
  *login() {
    return undefined
  },
  *refresh() {
    return undefined
  },
  *signService() {
    return undefined
  },
})
