/**
 * The names whose VALUES never reach telemetry by default (compared case-insensitively, after
 * decoding): query keys of `url.full` / `url.query` and — on a server — captured header names and
 * body / frame keys. The OTel semconv list (presigned S3 / GCS / Azure signatures) plus the usual
 * secrets. A list of your own replaces it (`FetchClient.use({ sensitiveKeys })`,
 * `createServer({ observe: { capture: { sensitiveKeys } } })`): `[...SENSITIVE_KEYS, 'my_key']`
 * adds to it.
 */
export const SENSITIVE_KEYS: readonly string[] = Object.freeze([
  'X-Amz-Signature',
  'X-Amz-Credential',
  'X-Amz-Security-Token',
  'AWSAccessKeyId',
  'Signature',
  'sig',
  'X-Goog-Signature',
  'key',
  'api_key',
  'apikey',
  'x-api-key',
  'token',
  'access_token',
  'refresh_token',
  'accesstoken',
  'refreshtoken',
  'x-auth-token',
  'password',
  'passwd',
  'secret',
  'client_secret',
  'private_key',
  'credential',
  'credentials',
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'session',
  'otp',
  'pin',
])
