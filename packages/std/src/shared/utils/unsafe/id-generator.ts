export const unsafeIdGenerator = function* (prefix: string) {
  let nextId = 0
  while (true) {
    yield `${prefix}:${++nextId}:${Date.now()}`
  }
}
