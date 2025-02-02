import { stat } from 'node:fs/promises'
import { statSync } from 'node:fs'

import { err, fromThrowable } from '../../results'

import { ioTags } from '../tag'

export const $stats = fromThrowable(stat, e =>
  err(ioTags.get('stats'), 'file not found').appendData(e)
)

export const $statsSync = fromThrowable(statSync, e =>
  err(ioTags.get('stats-sync'), 'file not found').appendData(e)
)
