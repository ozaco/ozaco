import { err, fromThrowable } from '../../results'

import { cryptoTags } from '../tag'

const HEX_TABLE = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'))

export const $id = fromThrowable(
  (length = 16) => {
    const byteLength = Math.ceil(length / 2)
    const array = crypto.getRandomValues(new Uint8Array(byteLength))

    let hex = ''
    for (let i = 0; i < byteLength; i++) {
      // biome-ignore lint/style/noNonNullAssertion: Redundant
      hex += HEX_TABLE[array[i]!]
    }

    return hex.slice(0, length)
  },
  e => err(cryptoTags.get('id'), 'failed to generate id').appendCause(cryptoTags.get('modern')).appendData(e),
) satisfies Std.Crypto.Api['id']
