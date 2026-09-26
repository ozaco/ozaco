import { createTags } from 'std:shared'

export const SchemaErrors = createTags(
  'std:schema',

  'no-match',
  'non-exhaustive',
  'validation',
  'async-schema',
)
