import { createTags } from './utils/tags'

export const SharedErrors = createTags(
  'std:shared',

  'no-match',
  'non-exhaustive',
  'validation',
  'async-schema',
)
