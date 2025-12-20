export type InferMapKey<T> = T extends Map<infer K, infer _V> ? K : never
export type InferMapValue<T> = T extends Map<infer _K, infer V> ? V : never
