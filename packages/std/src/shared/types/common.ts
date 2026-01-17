// biome-ignore lint/suspicious/noExplicitAny: For awareness
export type BlobType = any

// biome-ignore lint/complexity/noBannedTypes: For awareness
export type EmptyType = {}

export type IsPromise<T> = T extends Promise<BlobType> ? true : false
export type HasPromise<T> = object extends T ? false : T extends Promise<BlobType> ? true : false

export type MaybePromise<T> = T | Promise<T>

export type Writable<T> = { -readonly [P in keyof T]: T[P] }
export type DeepWriteable<T> = { -readonly [P in keyof T]: DeepWriteable<T[P]> }

export type ObjectFromKeyValue<K extends PropertyKey, V> = {
  [P in K]: V
}

export type Expand<T> = { [K in keyof T]: T[K] } & {}

export type Primitive = null | undefined | string | number | boolean | symbol | bigint

export type LiteralUnion<LiteralType, BaseType extends Primitive> = LiteralType | (BaseType & Record<never, never>)
