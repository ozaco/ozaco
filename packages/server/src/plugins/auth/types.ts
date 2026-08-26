import type { Operation } from 'std:effect'

export namespace AuthDef {
  export type TokenType = 'access' | 'refresh' | 'session' | 'service'

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

  export interface Options {
    readonly provider: Provider

    /** HS256 secret, or an asymmetric pair. One of the two. */
    readonly secret?: string | undefined
    readonly keys?: Keys | undefined

    /** `session`: one long-lived token. `access-refresh`: short access tokens rotated with
     * refresh tokens (the provider must implement the refresh hooks). Default `session`. */
    readonly mode?: 'session' | 'access-refresh' | undefined
    readonly sessionTtlMs?: number | undefined
    readonly accessTtlMs?: number | undefined
    readonly refreshTtlMs?: number | undefined

    /** the service tokens' lifetime. Default 1 h. */
    readonly serviceTtlMs?: number | undefined
  }

  /** The `auth` action option: who may call. `'authenticated'` = any verified principal
   * (`'any'` is its deprecated alias — same meaning); an array = required ROLES; the object
   * form requires roles AND/OR permissions; a predicate sees the full principal and decides
   * itself (`auth: (p) => p.permissions.includes('agents:view')`). */
  export type Requirement =
    | 'user'
    | 'service'
    | 'authenticated'
    | 'any'
    | readonly string[]
    | {
        readonly roles?: readonly string[] | undefined
        readonly permissions?: readonly string[] | undefined
      }
    | ((principal: Principal) => boolean)
    | false

  export interface Principal {
    readonly sub: string
    readonly type: TokenType
    readonly roles: readonly string[]
    readonly permissions: readonly string[]
    readonly claims: Record<string, unknown>
    readonly jti: string
  }

  /** A verified token's principal plus what rotation needs. */
  export interface Verified extends Principal {
    readonly family: string | undefined
    readonly exp: number | undefined
  }

  export interface Tokens {
    readonly accessToken: string
    readonly refreshToken?: string | undefined
    readonly expiresAt: number
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

  export interface Context {
    readonly mode: 'session' | 'access-refresh'
    readonly provider: Provider
    readonly material: Material
    readonly ttl: { session: number; access: number; refresh: number; service: number }
  }

  export interface Actions {
    /** Exchange credentials for tokens. */
    login(credentials: Record<string, unknown>): Operation<Tokens>

    /** Rotate a refresh token (access-refresh mode); a replayed token revokes its family. */
    refresh(refreshToken: string): Operation<Tokens>

    /** Verify a token into a principal. */
    verify(token: string): Operation<Principal>

    /** Mint a service-to-service token (`type: 'service'`, `sub: 'service:<name>'`). */
    signService(name: string, roles?: readonly string[]): Operation<string>

    /** The principal of the running dispatch (`ctx.auth`), or a failure when anonymous. */
    principal(): Operation<Principal>

    /** Enforce a requirement OUTSIDE a dispatch (socket handshakes, raw routes): a presented
     * bearer is ALWAYS verified (expired/malformed → `server.unauthorized`, refresh tokens
     * rejected), then the requirement gates. Resolves the principal (`null` when anonymous
     * and nothing was required). */
    authorize(
      requirement: Requirement,
      headers: Readonly<Record<string, string>>,
    ): Operation<Principal | null>
  }
}
