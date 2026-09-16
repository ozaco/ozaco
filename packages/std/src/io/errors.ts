import { createTags } from 'std:shared'

export const IOErrors = createTags(
  'std:io',

  'unsupported',
  'exists',
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
