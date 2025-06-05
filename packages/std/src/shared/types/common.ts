// biome-ignore lint/suspicious/noExplicitAny: <explanation>
export type BlobType = any

// biome-ignore lint/complexity/noBannedTypes: <explanation>
export type EmptyType = {}

export type Fn<A extends BlobType[], R> = (...args: A) => R

export type Promisify<T> = T | Promise<T>

export type IsPromise<T> = T extends PromiseLike<BlobType> ? true : false

export type GeneratorFn<A extends BlobType[], Y, R, N> = (...args: A) => Generator<Y, R, N>

export type AsyncGeneratorFn<A extends BlobType[], Y, R, N> = (
  ...args: A
) => AsyncGenerator<Y, R, N>
