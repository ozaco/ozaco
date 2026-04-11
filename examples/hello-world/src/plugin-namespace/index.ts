import { run } from 'std:effect'
import { install } from 'std:plugin'
import { unwrap } from 'std:result'

import { BunIO } from './bun'
import { Other } from './other'

const result = await run(function* () {
  yield* install(BunIO)
  yield* install(Other)

  const data = yield* Other.actions.read('./package.json')

  console.log(data)
})

unwrap(result)
