import type { Future, Operation } from 'std:effect'

export namespace AuthDef {
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

  /**
   * User-provided key material for JWT signing/verification. For asymmetric algorithms (RS/ES/EdDSA)
   * this must be a PKCS8/SPKI **PEM string** or a `CryptoKey` — a raw `Uint8Array` is rejected at
   * setup (jose cannot import raw asymmetric bytes). Raw HMAC secrets are supplied via `secret`, not
   * here, so `Uint8Array` carries no supported meaning today; it remains in the union only for
   * forward compatibility.
   */
  export type JWTKey = string | Uint8Array | CryptoKey

  /** Internal resolved key handed to jose (after PKCS8/SPKI import for asymmetric). */
  export type ResolvedKey = Uint8Array | CryptoKey | { type: string; export: () => unknown }

  export interface User {
    id: string
    [key: string]: unknown
  }

  export interface BaseOptions {
    /** HMAC secret (HS256/HS384/HS512). Required when algorithm is HMAC. */
    secret?: string
    /** PKCS8 PEM string or CryptoKey. Required for RS/ES/EdDSA algorithms (raw bytes are rejected). */
    privateKey?: JWTKey
    /** SPKI PEM string or CryptoKey. Used for verification when asymmetric (raw bytes are rejected). */
    publicKey?: JWTKey

    issuer?: string
    audience?: string
    algorithm?: JWTAlgorithm

    verification?: { expiresIn?: string }
  }

  export interface BaseContext {
    issuer: string | null
    audience: string | null
    algorithm: JWTAlgorithm

    verificationTTL: number
  }

  export interface Session<TUser extends User = User> {
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
    /**
     * Root of the rotation chain this token belongs to (the first token's jti), carried unchanged
     * through every rotation so a detected replay can revoke the whole line at once. Absent only on
     * records persisted before families existed — treat such a record's own jti as its root.
     */
    familyId?: string
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
    generateState: () => Operation<string>
    /**
     * Verify that the `state` returned by the OAuth2 callback matches the one
     * generated for this user before authorize. MUST fail with InvalidState when
     * the state is missing, expired, reused, or doesn't match the bound context.
     * Calling this is mandatory; the framework invokes it before exchange().
     */
    verifyState: (state: string) => Operation<void>
    authorize: (state: string) => Operation<string>
    exchange: (code: string) => Operation<SSOProfile>
  }

  export interface Provider<TUser extends User = User, TCredentials = unknown> {
    authenticate: (credentials: TCredentials) => Operation<TUser | null>
    loadUser: (userId: string) => Operation<TUser | null>

    saveRefreshToken?: (record: RefreshRecord) => Operation<void>
    findRefreshToken?: (jti: string) => Operation<RefreshRecord | null>
    revokeRefreshToken?: (jti: string) => Operation<void>
    /**
     * Compare-and-swap refresh rotation — the replay gate. In ONE atomic action: verify the stored
     * record for `expected.jti` still exists and is unrevoked, mark it revoked (keep it — a deleted
     * record cannot testify to a later replay), and persist `next`. Return `true` on success. When
     * the record is missing or already revoked, write NOTHING and return `false`: the token was
     * spent concurrently and the strategy treats that as a reuse (reused-token + family revocation).
     * If absent, the framework falls back to revoke + save (non-atomic, no replay detection).
     */
    rotateRefreshToken?: (expected: RefreshRecord, next: RefreshRecord) => Operation<boolean>
    /**
     * Revoke every live token whose family root matches `familyId` — the response to a detected
     * replay. Optional but strongly recommended next to rotateRefreshToken: without it a confirmed
     * theft only burns the presented token, leaving the line's live descendant in play.
     */
    revokeRefreshTokenFamily?: (familyId: string) => Operation<void>

    saveVerification?: (record: VerificationRecord) => Operation<void>
    findVerification?: (token: string) => Operation<VerificationRecord | null>
    consumeVerification?: (token: string) => Operation<void>

    getRoles?: (user: TUser) => Operation<string[]>
    getPermissions?: (user: TUser) => Operation<string[]>

    ssoProviders?: Record<string, SSOProvider>
    linkSSO?: (profile: SSOProfile) => Operation<TUser>
  }

  export type Events = {
    'signed-in': [user: User, session: Session]
    'signed-out': [userId: string, jti: string]
    refreshed: [session: Session]
    authorized: [session: Session]
    denied: [code: string, reason: string]
    verified: [userId: string, purpose: string]
    'sso-linked': [userId: string, provider: string]
  }

  export interface PrincipalClaims {
    user: User
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

  export interface JWTSessionOptions extends BaseOptions {
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

  export interface AccessRefreshOptions extends BaseOptions {
    access?: { expiresIn?: string }
    refresh?: { expiresIn?: string; rotate?: boolean }
  }

  export interface AccessRefreshTokens {
    accessToken: string
    refreshToken: string
    accessExpiresAt: number
    refreshExpiresAt: number
  }

  export interface Strategy {
    actions: { authorize: (token: string) => Future<AuthDef.Session> }
  }

  export interface IssueOptions {
    /** The live record being spent: rotation CAS-swaps exactly this record for the new one. */
    rotateFrom?: RefreshRecord | undefined
  }
}
