import type { Operation } from 'std:effect'

export type JWTAlgorithm =
  | 'HS256'
  | 'HS384'
  | 'HS512'
  | 'RS256'
  | 'RS384'
  | 'RS512'
  | 'ES256'
  | 'ES384'
  | 'ES512'
  | 'EdDSA'

/** User-provided key material for JWT signing/verification. */
export type JWTKey = string | Uint8Array | CryptoKey

/** Internal resolved key handed to jose (after PKCS8/SPKI import for asymmetric). */
export type ResolvedKey = Uint8Array | CryptoKey | { type: string; export: () => unknown }

export interface AuthUser {
  id: string
  [key: string]: unknown
}

export interface BaseAuthOptions {
  /** HMAC secret (HS256/HS384/HS512). Required when algorithm is HMAC. */
  secret?: string
  /** PKCS8 PEM string, raw bytes, or CryptoKey. Required for RS/ES/EdDSA algorithms. */
  privateKey?: JWTKey
  /** SPKI PEM string, raw bytes, or CryptoKey. Used for verification when asymmetric. */
  publicKey?: JWTKey

  issuer?: string
  audience?: string
  algorithm?: JWTAlgorithm

  verification?: { expiresIn?: string }
}

export interface BaseAuthContext {
  issuer: string | null
  audience: string | null
  algorithm: JWTAlgorithm

  verificationTTL: number
}

export interface AuthSession<TUser extends AuthUser = AuthUser> {
  sub: string
  jti: string
  iat: number
  exp: number
  type: string
  user: TUser
  roles: string[]
  permissions: string[]
}

export interface RefreshRecord {
  jti: string
  userId: string
  issuedAt: number
  expiresAt: number
  revokedAt: number | null
}

export interface VerificationRecord {
  token: string
  userId: string
  purpose: string
  expiresAt: number
  consumedAt: number | null
}

export interface SSOProfile {
  provider: string
  providerUserId: string
  email?: string
  name?: string
  raw?: unknown
}

export interface SSOProvider {
  /**
   * Generate an opaque CSRF token to be embedded in the OAuth2 `state` parameter
   * and persisted alongside the redirect (cookie/session). MUST be:
   *  - cryptographically random
   *  - bound to the user's pre-auth context (cookie/session id) by the provider
   * Framework will pass the same value to `authorize(state)` and later validate it
   * via `verifyState(state)` on callback.
   */
  generateState: () => Operation<string, unknown>
  /**
   * Verify that the `state` returned by the OAuth2 callback matches the one
   * generated for this user before authorize. MUST fail with InvalidState when
   * the state is missing, expired, reused, or doesn't match the bound context.
   * Calling this is mandatory; the framework invokes it before exchange().
   */
  verifyState: (state: string) => Operation<void, unknown>
  authorize: (state: string) => Operation<string, unknown>
  exchange: (code: string) => Operation<SSOProfile, unknown>
}

export interface AuthProvider<TUser extends AuthUser = AuthUser, TCredentials = unknown> {
  authenticate: (credentials: TCredentials) => Operation<TUser | null, unknown>
  loadUser: (userId: string) => Operation<TUser | null, unknown>

  saveRefreshToken?: (record: RefreshRecord) => Operation<void, unknown>
  findRefreshToken?: (jti: string) => Operation<RefreshRecord | null, unknown>
  revokeRefreshToken?: (jti: string) => Operation<void, unknown>
  /**
   * Atomic refresh token rotation. Provider must guarantee that revoking the old
   * jti and persisting the new record happen in the same transaction so
   * concurrent rotations cannot leave the user without a valid refresh token.
   * If absent, the framework falls back to revoke + save (non-atomic).
   */
  rotateRefreshToken?: (oldJti: string, newRecord: RefreshRecord) => Operation<void, unknown>

  saveVerification?: (record: VerificationRecord) => Operation<void, unknown>
  findVerification?: (token: string) => Operation<VerificationRecord | null, unknown>
  consumeVerification?: (token: string) => Operation<void, unknown>

  getRoles?: (user: TUser) => Operation<string[], unknown>
  getPermissions?: (user: TUser) => Operation<string[], unknown>

  ssoProviders?: Record<string, SSOProvider>
  linkSSO?: (profile: SSOProfile) => Operation<TUser, unknown>
}

export type AuthEvents = {
  'signed-in': [user: AuthUser, session: AuthSession]
  'signed-out': [userId: string, jti: string]
  refreshed: [session: AuthSession]
  authorized: [session: AuthSession]
  denied: [code: string, reason: string]
  verified: [userId: string, purpose: string]
  'sso-linked': [userId: string, provider: string]
}

export interface PrincipalClaims {
  user: AuthUser
  roles: string[]
  permissions: string[]
}

export interface TokenIssueResult {
  token: string
  jti: string
  issuedAt: number
  expiresAt: number
}

export interface JWTSessionContext {
  sessionTTL: number
}

export interface JWTSessionOptions extends BaseAuthOptions {
  session?: { expiresIn?: string }
}

export interface JWTSessionTokens {
  token: string
  expiresAt: number
}

export interface AccessRefreshContext {
  accessTTL: number
  refreshTTL: number
  rotateRefresh: boolean
}

export interface AccessRefreshOptions extends BaseAuthOptions {
  access?: { expiresIn?: string }
  refresh?: { expiresIn?: string; rotate?: boolean }
}

export interface AccessRefreshTokens {
  accessToken: string
  refreshToken: string
  accessExpiresAt: number
  refreshExpiresAt: number
}
