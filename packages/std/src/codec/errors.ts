import { createTags } from 'std:shared'

export const CodecErrors = createTags(
  'std:codec',

  'encode',
  'decode',
  'stringify',
  'parse',
  'encode-flow',
  'decode-flow',
  'no-codec',

  'no-match',
)
