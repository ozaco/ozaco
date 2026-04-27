import type { Operation } from 'std:effect'

export type JWTAlgorithm = 'HS256' | 'HS384' | 'HS512'

export interface AuthUser {
  id: string
  [key: string]: unknown
}

export interface BaseAuthOptions {
  secret: string

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
  authorize: (state: string) => Operation<string, unknown>
  exchange: (code: string, state: string) => Operation<SSOProfile, unknown>
}

export interface AuthProvider<TUser extends AuthUser = AuthUser, TCredentials = unknown> {
  authenticate: (credentials: TCredentials) => Operation<TUser | null, unknown>
  loadUser: (userId: string) => Operation<TUser | null, unknown>

  saveRefreshToken?: (record: RefreshRecord) => Operation<void, unknown>
  findRefreshToken?: (jti: string) => Operation<RefreshRecord | null, unknown>
  revokeRefreshToken?: (jti: string) => Operation<void, unknown>

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
