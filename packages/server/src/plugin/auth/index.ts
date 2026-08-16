/**
 * `server:plugin/auth` — `AuthStrategy` implementations: `JwtSessionAuth` (stateless session
 * JWTs) and `AccessRefreshAuth` (access/refresh pairs with CAS rotation + family revocation).
 * Consumer capabilities are ACTIONS on the installed strategy: `actions.user()` (the caller
 * `Principal` of the current request), `actions.authorizeSocket()` (a `SocketRoute.authorize`
 * guard) and `actions.signServiceToken(name)`. Keys: an HMAC secret string (HS256) or PKCS8/SPKI
 * PEM strings / CryptoKeys (RS256/ES256) via `jose`. Authorization failures are tagged
 * `CoreErrors.Unauthorized`/`Forbidden` (401/403 at the edge) with precise `AuthErrors` in the
 * causes.
 */
export * from './const'
export * from './definition'
export * from './errors'
export type * from './types'
