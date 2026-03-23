import { fail, guard, succeed } from 'std:result'
import { match } from 'std:shared'

import { z } from 'zod/mini'

const sayHi = guard(function* (target: unknown) {
  const name = yield* match(target)
    .with(z.string(), targetName => succeed(targetName))
    .otherwise(() => fail('unsupported target'))

  return `Hi ${name}` as const
})

console.log(sayHi('Alice'))
