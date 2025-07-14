import { randomBytes } from 'node:crypto'

import { err, fromThrowable } from '../../results'

import { cryptoTags } from '../tag'

export const $id = fromThrowable(
  (length = 16) =>
    randomBytes(Math.ceil(length / 2))
      .toString('hex')
      .slice(0, length),
  e => err(cryptoTags.get('id'), 'failed to generate id').appendCause(cryptoTags.get('legacy')).appendData(e),
) satisfies Std.Crypto.Api['id']
