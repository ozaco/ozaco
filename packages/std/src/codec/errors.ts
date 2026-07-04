import { createTags } from 'std:shared'

export const CodecErrors = createTags(
  'std:codec',

  'encode',
  'decode',
  'stringify',
  'parse',
  'encode-stream',
  'decode-stream',
  'no-codec',

  'no-match',
)
