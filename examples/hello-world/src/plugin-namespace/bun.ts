import { operation, until } from 'std:effect'

import { IO } from './definition'

export const BunIO = IO.implement({
  name: 'bun-io',
  version: '0.0.0',
  *setup() {},
}).build({
  readFile: operation(function* (path) {
    const fd = Bun.file(path)

    return yield* until(fd.text(), 'io:error')
  }),
  writeFile: operation(function* (path, data) {
    yield* until(Bun.write(path, data), 'io:error')
  }),

  sa: 123,
})
