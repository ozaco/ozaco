import type { KebabToPascal } from './string'

// oxlint-disable-next-line typescript/no-explicit-any
export type AnyType = any

// oxlint-disable-next-line no-empty-object-type
export type EmptyType = {}

export type AnyFunction = (value: AnyType) => AnyType

export type Writable<T> = { -readonly [P in keyof T]: T[P] }
export type WriteableDeep<T> = { -readonly [P in keyof T]: WriteableDeep<T[P]> }

/** Flatten an intersection into ONE object shape, so `Partial<A> & { id: string }` reads as
 * `{ a?: …; id: string }` in hovers and errors. Homomorphic (per-property `?`/`readonly` survive),
 * one level deep, identity in assignability. */
export type Simplify<T> = { [K in keyof T]: T[K] } & EmptyType

export type Tags<T extends string | null, U extends string[]> = {
  readonly [K in U[number] as KebabToPascal<K>]: T extends null ? K : `${T}.${K}`
}

export type IsPromise<T> = T extends Promise<AnyType> ? true : false
export type IsPromiseStrict<T> = object extends T
  ? false
  : T extends Promise<AnyType>
    ? true
    : false

export type GuardValue<fn> = fn extends ((value: AnyType) => value is infer b)
  ? b
  : fn extends (value: infer a) => unknown
    ? a
    : never

export type PromiseWithResolvers<T> = ReturnType<typeof Promise.withResolvers<T>>

export type Primitive = null | undefined | string | number | boolean | symbol | bigint

export type LiteralUnion<LiteralType, BaseType extends Primitive> =
  | LiteralType
  | (BaseType & Record<never, never>)

export type KnownKeys<T> = keyof {
  [K in keyof T as string extends K
    ? never
    : number extends K
      ? never
      : symbol extends K
        ? never
        : K]: T[K]
}

export type ExplicitObject<T> = Pick<T, KnownKeys<T> & keyof T>
