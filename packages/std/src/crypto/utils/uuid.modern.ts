import { err, fromThrowable } from '../../results'

import { cryptoTags } from '../tag'

export const $uuid = fromThrowable(
  () => crypto.randomUUID(),
  e => err(cryptoTags.get('uuid'), 'failed to generate uuid').appendCause(cryptoTags.get('modern')).appendData(e),
) satisfies Std.Crypto.Api['uuid']
