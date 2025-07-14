import { err, fromThrowable } from '../../results'

import { cryptoTags } from '../tag'

export const $id = fromThrowable(
  (length = 16) => {
    let value = ''

    const hexLength = Math.ceil(length / 2)

    for (let i = 0; i < hexLength; i++) {
      // biome-ignore lint/nursery/noBitwiseOperators: Redundant
      const n = (Math.random() * 256) | 0

      value += (n < 16 ? '0' : '') + n.toString(16)
    }

    return value.slice(0, length)
  },
  e => err(cryptoTags.get('id'), 'failed to generate id').appendCause(cryptoTags.get('unsafe')).appendData(e),
) satisfies Std.Crypto.Api['id']
