// oxlint-disable-next-line typescript/no-explicit-any
export type AnyType = any

// oxlint-disable-next-line no-empty-object-type
export type EmptyType = {}

export type AnyFunction = (value: AnyType) => AnyType

export type Writable<T> = { -readonly [P in keyof T]: T[P] }
export type WriteableDeep<T> = { -readonly [P in keyof T]: WriteableDeep<T[P]> }

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
