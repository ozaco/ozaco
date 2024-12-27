// biome-ignore lint/suspicious/noExplicitAny: <explanation>
export type BlobType = any

// biome-ignore lint/complexity/noBannedTypes: <explanation>
export type EmptyType = {}

export type Fn<T extends BlobType[], R> = (...args: T) => R

export type Promisify<T> = T | Promise<T>
