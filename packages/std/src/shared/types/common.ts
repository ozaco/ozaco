// biome-ignore lint/suspicious/noExplicitAny: For awareness
export type BlobType = any

// biome-ignore lint/complexity/noBannedTypes: For awareness
export type EmptyType = {}

export type IsPromise<T> = T extends PromiseLike<BlobType> ? true : false

export type MaybePromise<T> = T | Promise<T>
