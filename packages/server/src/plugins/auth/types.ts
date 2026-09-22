import type { OptionsDef } from 'server:core'
import type { Operation } from 'std:effect'

export namespace AuthDef {
  /** re-exported from core: the option shapes live next to the action config that carries them. */
  export type TokenType = OptionsDef.TokenType

  /** The `auth` action option: who may call — see {@link OptionsDef.Requirement}. */
  export type Requirement = OptionsDef.Requirement

  export type Principal = OptionsDef.Principal

  export interface Tokens {
    readonly accessToken: string
    readonly refreshToken?: string | undefined
    readonly expiresAt: number
  }

  // --- the strategy protocol -------------------------------------------------------------------

  /**
   * What every `AuthStrategy` impl may answer. `undefined` means "not mine — ask the next
   * strategy" (a static-token store handed a JWT, a JWT verifier handed an opaque key, a
   * verify-only strategy asked to `login`); a FAILURE is decisive and stops the chain (an expired
   * token, wrong credentials). Several strategies run side by side; the first answer wins.
   */
  export interface Strategy {
    verify(token: string): Operation<Principal | undefined>
    login(credentials: Record<string, unknown>): Operation<Tokens | undefined>
    refresh(refreshToken: string): Operation<Tokens | undefined>
    signService(name: string, roles?: readonly string[]): Operation<string | undefined>
  }

  export interface StrategyContext {
    /** `jwt`, `static`, … — what `describe`-style diagnostics name. */
    readonly strategy: string
  }

  // --- the coordinator ---------------------------------------------------------------------------

  export interface Options {
    /** The requirement of every action that sets no `auth` of its own (and whose service sets
     * none). Default `false` — open. `'authenticated'` makes the node fail-closed: a new action
     * is private until someone writes `auth: false` on it. */
    readonly default?: Requirement | undefined
  }

  export interface Context {
    readonly default: Requirement
  }

  export interface Actions {
    /** Exchange credentials for tokens — the first strategy that issues them answers. */
    login(credentials: Record<string, unknown>): Operation<Tokens>

    /** Rotate a refresh token; a replayed token revokes its family. */
    refresh(refreshToken: string): Operation<Tokens>

    /** Verify a bearer into a principal — the first strategy that recognizes it answers. */
    verify(token: string): Operation<Principal>

    /** Mint a service-to-service token (`type: 'service'`, `sub: 'service:<name>'`). */
    signService(name: string, roles?: readonly string[]): Operation<string>

    /** The principal of the running dispatch (`ctx.auth`), or a failure when anonymous. */
    principal(): Operation<Principal>

    /** Enforce a requirement OUTSIDE a dispatch (socket handshakes, raw routes): a presented
     * bearer is ALWAYS verified (unknown/expired → `server.unauthorized`), then the requirement
     * gates. Resolves the principal (`null` when anonymous and nothing was required). */
    authorize(
      requirement: Requirement,
      headers: Readonly<Record<string, string>>,
    ): Operation<Principal | null>
  }

  // --- the jwt strategy ------------------------------------------------------------------------

  /** What a provider resolves a caller to — `claims` travel into the principal and the token. */
  export interface User {
    readonly sub: string
    readonly roles?: readonly string[] | undefined
    readonly permissions?: readonly string[] | undefined
    readonly claims?: Record<string, unknown> | undefined
  }

  /** A stored refresh token (access-refresh mode). `rotate` must keep the consumed record
   * detectable (tombstone, don't delete) so a replay can be recognized and the family revoked. */

  export interface RefreshRecord {
    readonly jti: string
    readonly sub: string
    readonly family: string
    readonly expiresAt: number
    readonly revoked: boolean
  }

  /** The user-store seam. `authenticate` resolving `undefined` means bad credentials. */
  export interface Provider {
    authenticate(credentials: Record<string, unknown>): Operation<User | undefined>
    loadUser(sub: string): Operation<User | undefined>
    saveRefresh?(record: RefreshRecord): Operation<void>
    loadRefresh?(jti: string): Operation<RefreshRecord | undefined>

    /** CAS rotation: persist `next` only if `expectedJti` is still live — `false` = replay. */
    rotateRefresh?(expectedJti: string, next: RefreshRecord): Operation<boolean>
    revokeFamily?(family: string): Operation<void>
  }

  export type Alg = 'HS256' | 'ES256' | 'RS256'

  export interface Keys {
    readonly privateKey: CryptoKey | string
    readonly publicKey: CryptoKey | string
    readonly alg: 'ES256' | 'RS256'
  }

  export interface JwtOptions {
    /** HS256 secret, or an asymmetric pair. One of the two. */
    readonly secret?: string | undefined
    readonly keys?: Keys | undefined

    /** The user store behind `login` / `refresh`. Without one the strategy only VERIFIES tokens
     * (issued elsewhere with the same key) and mints service tokens. */
    readonly provider?: Provider | undefined

    /** `session`: one long-lived token. `access-refresh`: short access tokens rotated with
     * refresh tokens (the provider must implement the refresh hooks). Default `session`. */
    readonly mode?: 'session' | 'access-refresh' | undefined
    readonly sessionTtlMs?: number | undefined
    readonly accessTtlMs?: number | undefined
    readonly refreshTtlMs?: number | undefined

    /** the service tokens' lifetime. Default 1 h. */
    readonly serviceTtlMs?: number | undefined
  }

  /** A verified token's principal plus what rotation needs. */
  export interface Verified extends Principal {
    readonly family: string | undefined
    readonly exp: number | undefined
  }

  export interface Material {
    readonly alg: string
    readonly signKey: CryptoKey | Uint8Array
    readonly verifyKey: CryptoKey | Uint8Array
  }

  export interface Seed {
    readonly sub: string
    readonly type: TokenType
    readonly roles: readonly string[]
    readonly permissions: readonly string[]
    readonly claims: Record<string, unknown>
    readonly jti: string
    readonly family?: string | undefined
  }

  export interface JwtContext extends StrategyContext {
    readonly mode: 'session' | 'access-refresh'
    readonly provider: Provider | null
    readonly material: Material
    readonly ttl: { session: number; access: number; refresh: number; service: number }
  }

  // --- the static-token strategy -----------------------------------------------------------------

  /** A pre-shared (static) bearer: what it resolves to. The token itself is the key of the
   * `tokens` map — an opaque random string you rotate by config, never a JWT. */
  export interface StaticPrincipal {
    readonly sub: string

    /** `session` (a user-like caller, default) or `service` (an API key of another system). */
    readonly type?: 'session' | 'service' | undefined
    readonly roles?: readonly string[] | undefined
    readonly permissions?: readonly string[] | undefined
    readonly claims?: Record<string, unknown> | undefined
  }

  export interface StaticOptions {
    /** `{ '<token>': { sub, roles, type } }` — looked up verbatim. */
    readonly tokens: Readonly<Record<string, StaticPrincipal>>
  }

  export interface StaticContext extends StrategyContext {
    readonly tokens: ReadonlyMap<string, Principal>
  }
}
