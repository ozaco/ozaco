export type ExtendsGuard<T, G> = [
  T,
] extends [
  G,
]
  ? true
  : false
