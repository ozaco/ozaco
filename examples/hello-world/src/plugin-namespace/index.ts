import { run } from 'std:effect'
import { install } from 'std:plugin'
import { fail, unwrap } from 'std:result'

import { BunIO } from './bun'
import { Other } from './other'

const result = await run(function* () {
  yield* install(BunIO)
  yield* install(Other)

  yield* Other.before({
    *read([path]) {
      const ctx = yield* Other.useHook()

      if (path.includes('.yaml') || path.includes('.yml')) {
        ctx.set('parser', 'yaml')
      }
    },
  })

  yield* Other.after({
    *read() {
      const ctx = yield* Other.useHook()

      const parser = ctx.get('parser')

      if (parser === 'yaml') {
        yield* fail('not-implemented')
      }
    },
  })

  console.log(yield* Other.actions.read('./package.json'))
  console.log(yield* Other.actions.read('./moon.yml'))
})

unwrap(result)
