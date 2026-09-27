import { createTags } from 'std:shared'

/**
 * The io failure tags. `not-found` / `exists` / `access-denied` also say which platform error they
 * stand for (its `code`): a filesystem rejection is folded into them (`asFailure(error, IOErrors)`),
 * the platform error kept as the failure's `raw`.
 */
export const IOErrors = createTags(
  'std:io',

  'unsupported',
  ['not-found', { code: 'ENOENT' }],
  ['exists', { code: 'EEXIST' }],
  ['access-denied', { code: ['EACCES', 'EPERM'] }],
  'missing-env',

  'exec-failed',
  'exec-spawn-failed',
  'spawn-failed',
  'process-error',
  'kill-failed',
  'stdin-write-failed',

  'sign-failed',
  'verify-failed',
  'hlc-invalid',
  'decrypt-failed',
  's3-failed',

  'tcp-listen-failed',
  'tcp-connect-failed',
  'tcp-write-failed',
  'udp-bind-failed',
  'udp-send-failed',
)

/** The cause names io appends while unwinding a stream. */
export const IOCauses = createTags(
  'std:io',

  'stream',
  'write-stream',
  'readable-cancelled',
)
