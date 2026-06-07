import { createTags } from 'std:shared'

export const CodecErrors = createTags(
  'std:codec',

  'encode',
  'decode',
  'encode-stream',
  'decode-stream',
  'no-codec',
)
