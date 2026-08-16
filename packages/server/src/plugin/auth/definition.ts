/**
 * The strategy export site — implementations live under `internal/`, this file is the single
 * public assembly point: `JwtSessionAuth` (stateless session JWTs) and `AccessRefreshAuth`
 * (access/refresh pairs with CAS rotation + family revocation). Both implement the `AuthStrategy`
 * protocol from `server:core`, consumer capabilities included as actions: `user` (the caller of
 * the current request), `signServiceToken` and `authorizeSocket`.
 */
export { AccessRefreshAuth } from './internal/access-refresh'
export { JwtSessionAuth } from './internal/jwt-session'
