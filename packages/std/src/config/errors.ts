import { createTags } from 'std:shared'

export const ConfigErrors = createTags(
  'std:config',

  'read',
  'parse',
  'write',
  'delete',
  'extends',
  'no-working-file',
)
