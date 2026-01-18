import { createDefinition } from 'std:plugin'
import { guard } from 'std:result'
import type { BlobType } from 'std:shared'

import { IOErrors } from '../../const'
import type { Api, Impl } from '../../type'

export const stats = createDefinition((): Impl.Stats => {
  const createDummy = (type: 'number' | 'bigint'): Api.Stats<BlobType> => ({
    get isFile() {
      return false
    },
    get isDirectory() {
      return false
    },
    get isSymlink() {
      return false
    },
    get isBlockDevice() {
      return null
    },
    get isFifo() {
      return null
    },
    get isSocket() {
      return null
    },

    size: (type === 'number' ? 0 : 0n) as BlobType,

    modification: null,
    access: null,

    device: (type === 'number' ? 0 : 0n) as BlobType,
    mode: null,
    links: null,

    blocks: null,
    blockSize: null,
  })

  return {
    stats: guard(async (_handler, type?: BlobType) => {
      return createDummy(type ?? 'bigint')
    }, IOErrors.stats),

    statsSync: guard((_handler, type?: BlobType) => {
      return createDummy(type ?? 'bigint')
    }, IOErrors.statsSync),
  }
})
