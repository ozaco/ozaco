import type { BlobType } from 'std:shared'

import { Runtime } from '../../const'

export const detectRuntime = (): Runtime => {
  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    return Runtime.browser
  }

  if (
    typeof Bun !== 'undefined' ||
    (typeof process !== 'undefined' &&
      typeof process.versions === 'object' &&
      typeof (process.versions as BlobType).bun === 'string')
  ) {
    return Runtime.bun
  }

  if (typeof process !== 'undefined' && process.versions != null && typeof process.versions.node === 'string') {
    return Runtime.node
  }

  return Runtime.unknown
}
