import { createTags } from 'std:shared'

export const DbErrorCode = createTags(
  null,
  'connection-lost',
  'unique-violation',
  'foreign-key-violation',
  'check-violation',
  'not-found',
  'validation',
  'tx-conflict',
  'driver',
)
