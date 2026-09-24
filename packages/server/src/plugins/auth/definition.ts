import type { ServerDef } from 'server:core'
import { CtxRef, Server, ServerErrors } from 'server:core'
import type { Operation } from 'std:effect'
import { attempt } from 'std:effect'
import { definePlugin, defineProtocol } from 'std:plugin'
import type { Result } from 'std:result'
import { fail, isFailure } from 'std:result'

import pkg from '../../../package.json'

import { AuthCauses, AuthErrors } from './errors'
import { authorize, bearerOf, headerRecord, options } from './internal'
import type { AuthDef } from './types'

const AUTH_STRATEGY = Symbol.for('server:auth-strategy')

/**
 * The credential protocol — `JwtAuth`, `StaticAuth` (an SSO / API-key strategy of your own via
 * `AuthStrategy.implement(...)`) are its impls, installed SIDE BY SIDE. Every routed call
 * (`AuthStrategyProtocol.actions.verify(token)`, `.login(credentials)`, …) asks the strategies in install
 * order and answers with the FIRST SUCCESSFUL one: `undefined` and failures alike move on to the
 * next strategy (an expired JWT does not stop a static token from being tried). When nobody
 * succeeds, the first failure met is the answer — the most specific reason there is — and with
 * no failure at all the call resolves `undefined` (nobody knew the credential). A strategy
 * implements only what it supports and answers `undefined` for the rest.
 */
const AuthStrategyProtocol = defineProtocol<AuthDef.StrategyContext, AuthDef.Strategy>({
  name: 'server/auth-strategy',
  version: pkg.version,
  description: 'One way to turn credentials or a bearer into a principal',
  subtype: AUTH_STRATEGY,
  cloneable: true,

  defaults: {
    *verify() {
      return undefined
    },
    *login() {
      return undefined
    },
    *refresh() {
      return undefined
    },
    *signService() {
      return undefined
    },
  },

  *exec(entries, run) {
    let failure: Result.Failure<unknown> | null = null

    for (const entry of entries) {
      const answer = yield* attempt(() => run(entry))

      if (isFailure(answer)) {
        failure ??= answer
        continue
      }

      if (answer.value !== undefined) {
        return answer.value
      }
    }

    return failure ? yield* failure : undefined
  },
})

/** A presented bearer → its principal, through the strategy chain; nobody recognizing it is
 * `server.unauthorized`. */
function* resolve(token: string): Operation<AuthDef.Principal> {
  const principal = yield* AuthStrategyProtocol.actions.verify(token)

  if (!principal) {
    return yield* fail(
      ServerErrors.Unauthorized,
      'no auth strategy recognizes this token',
      AuthErrors.InvalidToken,
    )
  }

  return principal
}

/** A requirement against request headers: a presented bearer is always verified. */
function* authorizeHeaders(
  requirement: AuthDef.Requirement,
  headers: AuthDef.HeadersLike,
): Operation<AuthDef.Principal | null> {
  const token = bearerOf(headerRecord(headers))
  const principal = token ? yield* resolve(token) : undefined
  yield* authorize(principal, requirement)

  return principal ?? null
}

const AuthImpl = definePlugin<
  AuthDef.Context & ServerDef.PluginContext,
  [options?: AuthDef.Options]
>({
  name: 'server-auth',
  version: pkg.version,
  description: 'The auth gate over the installed AuthStrategy impls, as the `auth` action option',

  *setup(given) {
    if (!(yield* Server.context.get())) {
      return yield* fail(ServerErrors.Configuration, 'Auth must be installed by createServer')
    }

    // the chain is read on every call, but an install with nobody to ask is a mistake to name now
    if (!(yield* AuthStrategyProtocol.context.get())) {
      return yield* fail(
        ServerErrors.Configuration,
        'Auth needs at least one strategy installed BEFORE it — plugins: [JwtAuth.use({ secret, provider }), StaticAuth.use({ tokens }), Auth]',
      )
    }
    const context: AuthDef.Context = { default: given?.default ?? false }
    return {
      ...context,
      options,
      hooks: {
        name: 'auth',
        *dispatch(call, ctx, next) {
          // an action's own `auth` wins (a service-level one is already stamped on it); an
          // action that says nothing gets the install's `default`
          const own = (ctx.meta.options as { auth?: AuthDef.Requirement }).auth
          const requirement = own ?? context.default
          const token = bearerOf(call.headers)
          const principal = token ? yield* resolve(token) : undefined
          yield* authorize(principal, requirement)
          return yield* next(call, { ...ctx, auth: principal ?? null })
        },
        *guard(route, request) {
          // a raw route's own `auth` wins; one that says nothing is as closed as the install
          const requirement = route.auth ?? context.default

          if (requirement !== false) {
            return yield* authorizeHeaders(requirement, request.headers)
          }

          // a public route (health, docs, static files) never fails on a stale bearer — it is
          // simply served anonymously
          const token = bearerOf(headerRecord(request.headers))
          const known = token ? yield* attempt(() => resolve(token)) : null

          return known && !isFailure(known) ? known.value : null
        },
      },
    }
  },
})

/**
 * Authentication: install one or more strategies, then `Auth` — `plugins: [JwtAuth.use({ secret,
 * provider, mode }), StaticAuth.use({ tokens }), Auth.use({ default })]`. Every dispatch with a
 * bearer gets its principal on `ctx.auth` from whichever strategy recognizes it; `action({ auth:
 * 'user' | 'service' | 'authenticated' | [roles] })` gates the action (`server.unauthorized` /
 * `server.forbidden`), `service(name, actions, { auth })` sets it for a whole service and
 * `default` for every action that says nothing (`'authenticated'` = fail-closed) — and for every
 * raw edge route that says nothing (`Edge.actions.raw({ auth })`).
 * `Auth.actions.login/refresh/verify/signService` route to the first strategy that answers.
 */
/** The strategy protocol — see the definition above; exported here so the exports stay last. */
export const AuthStrategy = AuthStrategyProtocol

export const Auth = AuthImpl.build<AuthDef.Actions>({
  *login(credentials) {
    const tokens = yield* AuthStrategyProtocol.actions.login(credentials)
    if (!tokens) {
      return yield* fail(
        ServerErrors.Configuration,
        'no auth strategy issues tokens — install JwtAuth with a `provider`',
      )
    }
    return tokens
  },

  *refresh(refreshToken) {
    const tokens = yield* AuthStrategyProtocol.actions.refresh(refreshToken)
    if (!tokens) {
      return yield* fail(
        ServerErrors.Unsupported,
        'no auth strategy rotates refresh tokens — JwtAuth needs mode: access-refresh',
      )
    }
    return tokens
  },

  *verify(token) {
    return yield* resolve(token)
  },

  *signService(name, roles = []) {
    const token = yield* AuthStrategyProtocol.actions.signService(name, roles)
    if (!token) {
      return yield* fail(
        ServerErrors.Configuration,
        'no auth strategy mints service tokens — install JwtAuth',
      )
    }
    return token
  },

  *principal() {
    const ctx = yield* CtxRef.get()
    const principal = ctx?.auth as AuthDef.Principal | undefined
    if (!principal) {
      return yield* fail(
        ServerErrors.Unauthorized,
        'no principal on this dispatch',
        AuthCauses.Missing,
      )
    }
    return principal
  },

  authorize: authorizeHeaders,

  *check(requirement, headers) {
    const verdict = yield* attempt(() => authorizeHeaders(requirement, headers))

    if (!isFailure(verdict)) {
      return verdict.value
    }

    if (verdict.error === ServerErrors.Unauthorized || verdict.error === ServerErrors.Forbidden) {
      return null
    }

    return yield* verdict
  },
})
