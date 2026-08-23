/** The failure tags the Auth plugin raises besides the server's own. */
export const AuthErrors = {
  InvalidToken: 'auth.invalid-token',
  ExpiredToken: 'auth.expired-token',
  Replayed: 'auth.replayed',
  BadCredentials: 'auth.bad-credentials',
} as const
