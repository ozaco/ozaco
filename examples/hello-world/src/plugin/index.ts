import { main } from 'std:effect'
import { install } from 'std:plugin'

import { UserPlugin } from './users'

await main(function* () {
  yield* install(UserPlugin, 'Sa')

  try {
    yield* UserPlugin.actions.greet('Asuna')
  } finally {
    console.log('here')
  }
})
