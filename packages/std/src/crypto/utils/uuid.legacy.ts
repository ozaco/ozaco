import { randomUUID } from 'node:crypto'

import { err, fromThrowable } from '../../results'

import { cryptoTags } from '../tag'

export const $uuid = fromThrowable(
  () => randomUUID(),
  e => err(cryptoTags.get('uuid'), 'failed to generate uuid').appendCause(cryptoTags.get('legacy')).appendData(e),
) satisfies Std.Crypto.Api['uuid']
