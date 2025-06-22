import type { BlobType } from '../types/common'

/**
 * Checks if value is an promise
 */
export const isPromise = (value: unknown): value is PromiseLike<BlobType> => {
  return typeof value === 'object' && typeof (value as BlobType)?.then === 'function'
}

// biome-ignore lint/complexity/noBannedTypes: redundant
export const isFunction = (value: unknown): value is Function => {
  return typeof value === 'function'
}
