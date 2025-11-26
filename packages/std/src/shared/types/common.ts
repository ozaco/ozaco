// biome-ignore lint/suspicious/noExplicitAny: For awareness
export type BlobType = any

// biome-ignore lint/complexity/noBannedTypes: For awareness
export type EmptyType = {}

export type IsPromise<T> = T extends Promise<BlobType> ? true : false
export type HasPromise<T> = object extends T ? false : Promise<BlobType> extends T ? true : false

export type MaybePromise<T> = T | Promise<T>

export type Writable<T> = { -readonly [P in keyof T]: T[P] }
export type DeepWriteable<T> = { -readonly [P in keyof T]: DeepWriteable<T[P]> }
