// oxlint-disable import/exports-last
import { Server, ServerErrors, tagOf } from 'server:core'
import type { Operation } from 'std:effect'
import { attempt, createContext, until } from 'std:effect'
import { IO } from 'std:io'
import type { Result } from 'std:result'
import { asFailure, fail, isFailure } from 'std:result'
import type { TraceDef } from 'std:trace'
import { Trace } from 'std:trace'

import { importPKCS8, importSPKI, jwtVerify, SignJWT } from 'jose'
import { z } from 'zod'

import { AuthCauses, AuthErrors } from './errors'
import type { AuthDef } from './types'

const ENCODER = new TextEncoder()
const BEARER = 'bearer '

/** The span event a strategy that FAILED before a later one answered leaves (≤ 20 chars). */
const SKIP_EVENT = 'auth.skip'

export const HOUR = 60 * 60 * 1000
export const DAY = 24 * HOUR

// --- shared by the coordinator and every strategy ------------------------------------------------

/** Headers as a lower-cased record: a web `Headers` or a record in any casing. */
export const headerRecord = (headers: AuthDef.HeadersLike): Record<string, string> => {
  const record: Record<string, string> = {}

  if (headers instanceof Headers) {
    // oxlint-disable-next-line unicorn/no-array-for-each
    headers.forEach((value, key) => {
      record[key.toLowerCase()] = value
    })

    return record
  }

  for (const [key, value] of Object.entries(headers)) {
    record[key.toLowerCase()] = value
  }

  return record
}

/** The bearer token of a request, if any. */
export const bearerOf = (headers: Readonly<Record<string, string>>): string | null => {
  const header = headers.authorization ?? headers.Authorization

  if (!header || !header.toLowerCase().startsWith(BEARER)) {
    return null
  }

  const token = header.slice(BEARER.length).trim()

  return token === '' ? null : token
}

/** Whether a principal satisfies an action's `auth` requirement; a failure says why not. */
export function* authorize(
  principal: AuthDef.Principal | undefined,
  requirement: AuthDef.Requirement,
): Operation<void> {
  if (requirement === false) {
    return
  }

  if (!principal) {
    return yield* fail(ServerErrors.Unauthorized, 'authentication required', AuthCauses.Missing)
  }

  if (requirement === 'authenticated') {
    return
  }

  if (requirement === 'user' && principal.type === 'service') {
    return yield* fail(ServerErrors.Forbidden, 'a user token is required', AuthCauses.ServiceToken)
  }

  if (requirement === 'service' && principal.type !== 'service') {
    return yield* fail(ServerErrors.Forbidden, 'a service token is required', AuthCauses.UserToken)
  }

  if (typeof requirement === 'function') {
    if (!requirement(principal)) {
      return yield* fail(ServerErrors.Forbidden, 'auth predicate rejected', AuthCauses.Predicate)
    }

    return
  }

  if (Array.isArray(requirement)) {
    return yield* requireRoles(principal, requirement as readonly string[])
  }

  if (typeof requirement === 'object') {
    const shaped = requirement as {
      readonly roles?: readonly string[]
      readonly permissions?: readonly string[]
    }

    if (shaped.roles) {
      yield* requireRoles(principal, shaped.roles)
    }

    if (shaped.permissions) {
      const missing = shaped.permissions.filter(
        permission => !principal.permissions.includes(permission),
      )

      if (missing.length > 0) {
        return yield* fail(
          ServerErrors.Forbidden,
          `missing permission(s): ${missing.join(', ')}`,
          AuthCauses.Permission,
        )
      }
    }
  }
}

function* requireRoles(principal: AuthDef.Principal, roles: readonly string[]): Operation<void> {
  const missing = roles.filter(role => !principal.roles.includes(role))

  if (missing.length > 0) {
    return yield* fail(
      ServerErrors.Forbidden,
      `missing role(s): ${missing.join(', ')}`,
      AuthCauses.Role,
    )
  }
}

// --- telemetry: the verdict on the guarded span ------------------------------------------------

/** The bearer resolution in progress — set by the coordinator around the chain's `verify`: the
 * chain notes who decided, a strategy notes why it said "not mine" ({@link reject}). */
export const ResolutionRef = createContext<AuthDef.Resolution | null>(
  'server:auth.resolution',
  null,
)

/** A strategy's reason for "not mine" (a jose verification error, classified): kept as the cause
 * of the `no auth strategy recognizes this token` failure — the first reason met wins. Outside a
 * resolution (a `refresh`, a pinned call) it goes nowhere. */
export function* reject(reason: Result.Failure<unknown>): Operation<void> {
  const resolution = yield* ResolutionRef.get()

  if (resolution && resolution.rejection === undefined) {
    resolution.rejection = reason
  }
}

/** The name an installed strategy goes by: its context's `strategy`, else its plugin name. */
export const strategyOf = (entry: { readonly tag: string; readonly value: unknown }): string => {
  const named = (entry.value as Partial<AuthDef.StrategyContext> | null | undefined)?.strategy

  return typeof named === 'string' && named !== '' ? named : entry.tag.replace(/@[^@]*$/u, '')
}

/** One `auth.skip` event on the guarded span (`at`, else the active one) per strategy that
 * FAILED before a later one answered — `{ ozaco.auth.strategy, error.type }` (the failure itself
 * is dropped: it was not the answer). */
export function* skipped(
  failed: readonly (readonly [strategy: string, failure: Result.Failure<unknown>])[],
  at?: TraceDef.SpanHandle,
): Operation<void> {
  if (failed.length === 0) {
    return
  }

  const span = at ?? (yield* Trace.actions.current())

  for (const [strategy, failure] of failed) {
    span.addEvent(SKIP_EVENT, { 'ozaco.auth.strategy': strategy, 'error.type': tagOf(failure) })
  }
}

/** A requirement's kind — the `ozaco.auth.requirement` value (never the roles themselves). */
export const requirementKind = (requirement: AuthDef.Requirement): AuthDef.RequirementKind => {
  if (requirement === false) {
    return 'open'
  }

  if (requirement === 'authenticated' || requirement === 'user' || requirement === 'service') {
    return requirement
  }

  if (typeof requirement === 'function') {
    return 'predicate'
  }

  return Array.isArray(requirement) ? 'roles' : 'requirements'
}

/**
 * Say a gate's verdict on the guarded span `span` — the DISPATCH span of an action
 * (`dispatchSpan()`, even under a plugin span wrapping it), the edge span of a raw route, the
 * upgrade / first-frame span of a socket handshake, the active span of an `authorize` / `check`:
 * `ozaco.auth.outcome`, `ozaco.auth.requirement`, `ozaco.auth.strategy` and — only with the
 * global `capture.enduser` on (personal data) — `enduser.id`. A denial is still the call's
 * failure: the kernel classifies it (401 / 403 ⇒ status unset + `error.type`, one WARN record).
 */
export function* annotate(verdict: AuthDef.Verdict, span: TraceDef.SpanHandle): Operation<void> {
  if (!span.recording) {
    return
  }

  const kernel = yield* Server.context.get()
  const enduser = kernel?.telemetry.observe.capture.enduser === true

  span.setAttributes({
    'ozaco.auth.outcome': verdict.outcome,
    'ozaco.auth.requirement': requirementKind(verdict.requirement),
    'ozaco.auth.strategy': verdict.strategy,
    'enduser.id': enduser ? verdict.principal?.sub : undefined,
  })
}

/** The `auth` action option (validated by the kernel). */
export const options = {
  auth: z.union([
    z.literal('user'),
    z.literal('service'),
    z.literal('authenticated'),
    z.literal(false),
    z.array(z.string()),
    z.strictObject({
      roles: z.array(z.string()).optional(),
      permissions: z.array(z.string()).optional(),
    }),
    z.custom<(principal: unknown) => boolean>(value => typeof value === 'function'),
  ]),
}

// --- jwt ------------------------------------------------------------------------------------------

function* importKey(key: CryptoKey | string, alg: string, kind: 'private' | 'public') {
  if (typeof key !== 'string') {
    return key
  }

  const imported = yield* attempt(() =>
    until(kind === 'private' ? importPKCS8(key, alg) : importSPKI(key, alg)),
  )

  if (isFailure(imported)) {
    // the import's own error (its fold) stays as the cause, one level under the configuration
    return yield* fail(ServerErrors.Configuration, `auth: cannot import ${kind} key`, imported)
  }

  return imported.value
}

/** Install options → jose key material: HMAC secret → HS256, PEM/CryptoKey pair → its alg. */
export function* materialOf(given: AuthDef.JwtOptions): Operation<AuthDef.Material> {
  if (given.secret !== undefined) {
    if (given.secret.length === 0) {
      return yield* fail(ServerErrors.Configuration, 'auth: secret must be a non-empty string')
    }

    const bytes = ENCODER.encode(given.secret)

    return { alg: 'HS256', signKey: bytes, verifyKey: bytes }
  }

  if (!given.keys) {
    return yield* fail(ServerErrors.Configuration, 'auth: give a `secret` (HS256) or a `keys` pair')
  }

  return {
    alg: given.keys.alg,
    signKey: yield* importKey(given.keys.privateKey, given.keys.alg, 'private'),
    verifyKey: yield* importKey(given.keys.publicKey, given.keys.alg, 'public'),
  }
}

export function* sign(
  material: AuthDef.Material,
  seed: AuthDef.Seed,
  ttlMs: number,
): Operation<string> {
  const outcome = yield* attempt(() =>
    until(
      new SignJWT({
        type: seed.type,
        roles: [...seed.roles],
        permissions: [...seed.permissions],
        claims: seed.claims,
        ...(seed.family ? { family: seed.family } : {}),
      })
        .setProtectedHeader({ alg: material.alg })
        .setSubject(seed.sub)
        .setJti(seed.jti)
        .setIssuedAt()
        .setExpirationTime(new Date(Date.now() + ttlMs))
        .sign(material.signKey),
    ),
  )

  if (isFailure(outcome)) {
    return yield* fail(ServerErrors.Internal, 'auth: token signing failed', outcome)
  }

  return outcome.value
}

const strings = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []

/**
 * Verify a JWT against this material. `undefined` = not a token of ours (not a JWT at all,
 * another key, a malformed payload) — another strategy may still recognize it, and jose's reason
 * becomes the cause should nobody do so; an EXPIRED token of ours fails, jose's error its cause.
 */
export function* verify(
  material: AuthDef.Material,
  token: string,
): Operation<AuthDef.Verified | undefined> {
  const outcome = yield* attempt(() =>
    until(jwtVerify(token, material.verifyKey, { algorithms: [material.alg] })),
  )

  // jose's error is KEPT, classified by its `code` (`AuthErrors`): the expiry failure's cause,
  // else the reason this token is "not mine" — one level under the auth failure
  if (isFailure(outcome)) {
    const reason = asFailure(outcome, AuthErrors)

    if (reason.error === AuthErrors.ExpiredToken) {
      return yield* fail(
        ServerErrors.Unauthorized,
        'token expired',
        AuthErrors.ExpiredToken,
        reason,
      )
    }

    yield* reject(reason)

    return undefined
  }

  const raw = outcome.value.payload
  const type = raw.type

  if (
    typeof raw.sub !== 'string' ||
    typeof raw.jti !== 'string' ||
    (type !== 'access' && type !== 'refresh' && type !== 'session' && type !== 'service')
  ) {
    return undefined
  }

  return {
    sub: raw.sub,
    jti: raw.jti,
    type,
    roles: strings(raw.roles),
    permissions: strings(raw.permissions),
    claims: (raw.claims && typeof raw.claims === 'object' ? raw.claims : {}) as Record<
      string,
      unknown
    >,
    family: typeof raw.family === 'string' ? raw.family : undefined,
    exp: typeof raw.exp === 'number' ? raw.exp : undefined,
  }
}

/** The tokens a fresh login yields: one session token, or an access + refresh pair (saved
 * through the context's provider — the caller has already made sure there is one). */
export function* tokensFor(
  context: AuthDef.JwtContext,
  user: AuthDef.User,
  family: string,
): Operation<AuthDef.Tokens> {
  const { provider } = context

  if (!provider) {
    return yield* fail(ServerErrors.Configuration, 'auth: issuing tokens needs a provider')
  }

  const base = {
    sub: user.sub,
    roles: user.roles ?? [],
    permissions: user.permissions ?? [],
    claims: user.claims ?? {},
  }

  if (context.mode === 'session') {
    const ttl = context.ttl.session

    return {
      accessToken: yield* sign(
        context.material,
        { ...base, type: 'session', jti: yield* IO.actions.uuid() },
        ttl,
      ),
      expiresAt: Date.now() + ttl,
    }
  }

  const refreshJti = yield* IO.actions.uuid()

  const refresh: AuthDef.RefreshRecord = {
    jti: refreshJti,
    sub: user.sub,
    family,
    expiresAt: Date.now() + context.ttl.refresh,
    revoked: false,
  }

  yield* provider.saveRefresh!(refresh)

  return {
    accessToken: yield* sign(
      context.material,
      { ...base, type: 'access', jti: yield* IO.actions.uuid() },
      context.ttl.access,
    ),

    refreshToken: yield* sign(
      context.material,
      { ...base, type: 'refresh', jti: refreshJti, family },
      context.ttl.refresh,
    ),
    expiresAt: Date.now() + context.ttl.access,
  }
}
