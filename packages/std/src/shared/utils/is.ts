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

export const isObject = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export const isUndefined = (value: unknown): value is undefined => {
  return typeof value === 'undefined'
}

export const isArray = <T>(value: unknown): value is T[] => {
  return Array.isArray(value)
}

export const isString = (value: unknown): value is string => {
  return typeof value === 'string'
}

export const isBoolean = (value: unknown): value is boolean => {
  return typeof value === 'boolean'
}

export const isGenerator = (value: unknown): value is Generator<BlobType, BlobType> => {
  return typeof value === 'object' && typeof (value as Generator<BlobType, BlobType>)?.[Symbol.iterator] === 'function'
}

export const isAsyncGenerator = (value: unknown): value is AsyncGenerator<BlobType, BlobType> => {
  return (
    typeof value === 'object' &&
    typeof (value as AsyncGenerator<BlobType, BlobType>)?.[Symbol.asyncIterator] === 'function'
  )
}

export const isNumber = (x: unknown): x is number => {
  return typeof x === 'number'
}

export const isArrayBuffer = (x: unknown): x is ArrayBuffer => {
  return typeof x === 'object' && x !== null && Object.prototype.toString.call(x) === '[object ArrayBuffer]'
}

export const isSharedArrayBuffer = (x: unknown): x is SharedArrayBuffer => {
  return (
    typeof SharedArrayBuffer !== 'undefined' &&
    typeof x === 'object' &&
    x !== null &&
    Object.prototype.toString.call(x) === '[object SharedArrayBuffer]'
  )
}

export const isArrayBufferView = (x: unknown): x is ArrayBufferView => {
  return typeof x === 'object' && x !== null && ArrayBuffer.isView(x)
}
