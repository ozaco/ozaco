import type { Principal } from 'server:core'
import type { BoundLogger } from 'server:utils'
import type { Operation } from 'std:effect'

/** The token kinds strategies mint (`session` for jwt-session, `access`/`refresh` for pairs). */
export type TokenType = 'access' | 'refresh' | 'session'

/** What a provider resolves a caller to — `claims` travel into the principal and the token. */
export interface AuthUser {
  readonly sub: string
  readonly claims?: Record<string, unknown> | undefined
}

/**
 * The user-store seam every strategy talks to. `authenticate` returning `undefined` means invalid
 * credentials; the refresh members are only required by `AccessRefreshAuth` (validated at setup).
 * A conforming `rotateRefreshToken` must keep the consumed record detectable (tombstone it, don't
 * delete it) so token replay can be recognized and the family revoked.
 */
export interface AuthProvider {
  authenticate(credentials: Record<string, unknown>): Operation<AuthUser | undefined>
  loadUser(sub: string): Operation<AuthUser | undefined>
  getRoles?(user: AuthUser): Operation<readonly string[]>
  getPermissions?(user: AuthUser): Operation<readonly string[]>
  saveRefreshToken?(record: Auth.RefreshRecord): Operation<void>
  loadRefreshToken?(jti: string): Operation<Auth.RefreshRecord | undefined>
  /** CAS rotation: persist `next` only if `expectedJti` is still live — `false` means replay. */
  rotateRefreshToken?(expectedJti: string, next: Auth.RefreshRecord): Operation<boolean>
  revokeRefreshFamily?(familyId: string): Operation<void>
}

/** An {@link AuthProvider} with the refresh CRUD hooks required by `AccessRefreshAuth`. */
export interface AccessRefreshProvider extends AuthProvider {
  saveRefreshToken(record: Auth.RefreshRecord): Operation<void>
  loadRefreshToken(jti: string): Operation<Auth.RefreshRecord | undefined>
  rotateRefreshToken(expectedJti: string, next: Auth.RefreshRecord): Operation<boolean>
  revokeRefreshFamily(familyId: string): Operation<void>
}

export interface JwtSessionOptions extends Auth.KeyOptions {
  readonly provider: AuthProvider
  readonly sessionTtlMs?: number | undefined
}

export interface AccessRefreshOptions extends Auth.KeyOptions {
  /** Must supply the refresh CRUD + CAS rotation + family revocation hooks (checked at setup). */
  readonly provider: AuthProvider
  readonly accessTtlMs?: number | undefined
  readonly refreshTtlMs?: number | undefined
}

/**
 * The cold half of the auth surface — key configuration, token wire shapes, strategy contexts and
 * action result types, grouped `Result.Failure`-style so the hot types above stay skimmable.
 * Types only: the namespace is fully erased and re-exported via `export type *`.
 */
export namespace Auth {
  /** Asymmetric JWS algorithms accepted for PEM/CryptoKey pairs. */
  export type AsymmetricAlg = 'ES256' | 'RS256'

  /** An asymmetric key pair: PKCS8 PEM (private) / SPKI PEM (public) strings, or CryptoKeys. */
  export interface KeyPair {
    readonly privateKey: CryptoKey | string
    readonly publicKey: CryptoKey | string
    readonly alg: AsymmetricAlg
  }

  /** Key configuration: an HMAC `secret` string (HS256) OR an asymmetric `keys` pair. */
  export interface KeyOptions {
    readonly secret?: string | undefined
    readonly keys?: KeyPair | undefined
  }

  /** Resolved jose key material — HS256 shares one byte key, asymmetric algs split sign/verify. */
  export interface KeyMaterial {
    readonly alg: string
    readonly signKey: CryptoKey | Uint8Array
    readonly verifyKey: CryptoKey | Uint8Array
  }

  /** What a strategy embeds when minting a token. */
  export interface TokenSeed {
    readonly sub: string
    readonly jti: string
    readonly type: TokenType
    readonly roles: readonly string[]
    readonly permissions: readonly string[]
    readonly claims: Record<string, unknown>
  }

  /** A verified token payload — {@link TokenSeed} plus the standard timestamps. */
  export interface TokenPayload extends TokenSeed {
    readonly iat?: number | undefined
    readonly exp?: number | undefined
  }

  /** One persisted refresh token generation — `familyId` links every rotation of one sign-in. */
  export interface RefreshRecord {
    readonly jti: string
    readonly sub: string
    readonly familyId: string
    readonly expiresAt: number
    readonly revoked?: boolean | undefined
  }

  /** The context members shared by both strategies. */
  export interface StrategyCore {
    readonly material: KeyMaterial
    readonly provider: AuthProvider
    readonly log: BoundLogger
  }

  export interface JwtSessionContext extends StrategyCore {
    readonly sessionTtlMs: number
  }

  export interface AccessRefreshContext extends StrategyCore {
    readonly provider: AccessRefreshProvider
    readonly accessTtlMs: number
    readonly refreshTtlMs: number
  }

  /** What `JwtSessionAuth.actions.signIn` resolves to. */
  export interface SessionSignIn {
    readonly token: string
    readonly principal: Principal
  }

  /** What `AccessRefreshAuth.actions.signIn`/`refresh` resolve to. */
  export interface TokenPair {
    readonly accessToken: string
    readonly refreshToken: string
    readonly principal: Principal
  }
}
