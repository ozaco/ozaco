import { createTags } from 'std:shared'

export const FetchErrors = createTags(
  'std:fetch',

  'timeout',
  'http-status',
  'parse',
)
