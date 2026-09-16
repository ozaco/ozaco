import type { AnyType } from '../types/common'

/** Checks whether a value is a promise-like (anything with a callable `then`). */
export const isPromise = (value: unknown): value is PromiseLike<AnyType> =>
  !!value && typeof (value as AnyType)?.then === 'function'

/** Checks whether a value is callable. */
// oxlint-disable-next-line typescript/no-unsafe-function-type
export const isFunction = (value: unknown): value is Function => typeof value === 'function'

/** Checks whether a value is a non-null, non-array object. */
export const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Checks whether a value is `undefined`. */
export const isUndefined = (value: unknown): value is undefined => value === undefined

/** Checks whether a value is an array (`Array.isArray`). */
export const isArray = <T>(value: unknown): value is T[] => Array.isArray(value)

/** Checks whether a value is a string primitive. */
export const isString = (value: unknown): value is string => typeof value === 'string'

/** Checks whether a value is a boolean primitive. */
export const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean'

/** Checks whether a value is a sync generator object (`next` + `Symbol.iterator`). */
export const isGenerator = (value: unknown): value is Generator<AnyType, AnyType> =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as AnyType).next === 'function' &&
  typeof (value as AnyType)[Symbol.iterator] === 'function'

/** Checks whether a value is an async generator object (`next` + `Symbol.asyncIterator`). */
export const isAsyncGenerator = (value: unknown): value is AsyncGenerator<AnyType, AnyType> =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as AnyType).next === 'function' &&
  typeof (value as AnyType)[Symbol.asyncIterator] === 'function'

/** Checks whether a value is a number primitive (including `NaN`). */
export const isNumber = (value: unknown): value is number => typeof value === 'number'

/** Checks whether a value is an `ArrayBuffer` (by its `Object.prototype.toString` tag). */
export const isArrayBuffer = (value: unknown): value is ArrayBuffer =>
  typeof value === 'object' &&
  value !== null &&
  Object.prototype.toString.call(value) === '[object ArrayBuffer]'

/** Checks whether a value is a `SharedArrayBuffer`; always false where the global is missing. */
export const isSharedArrayBuffer = (value: unknown): value is SharedArrayBuffer =>
  typeof SharedArrayBuffer !== 'undefined' &&
  typeof value === 'object' &&
  value !== null &&
  Object.prototype.toString.call(value) === '[object SharedArrayBuffer]'

/** Checks whether a value is a typed array or `DataView` (`ArrayBuffer.isView`). */
export const isArrayBufferView = (value: unknown): value is ArrayBufferView =>
  typeof value === 'object' && value !== null && ArrayBuffer.isView(value)

/** Checks whether a value is async-iterable (has a callable `Symbol.asyncIterator`). */
export const isAsyncIterable = (value: unknown): value is AsyncIterable<unknown> =>
  value !== null &&
  typeof value === 'object' &&
  typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function'
