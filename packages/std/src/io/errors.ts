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

  'hlc-invalid',
  'decrypt-failed',
  's3-failed',
)
