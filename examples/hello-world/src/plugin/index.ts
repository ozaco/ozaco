import { run, useContext } from 'std:effect'
import { install } from 'std:plugin'
import { unwrap } from 'std:result'

import { external, UserPlugin } from './users'

const result = await run(function* () {
  yield* install(UserPlugin, 'Welcome')

  console.log('context:', yield* useContext(external))

  try {
    const greeting = yield* UserPlugin.actions.greet('Kirito')

    console.log('result:', greeting)
  } catch (error) {
    console.log('error:', error)
  } finally {
    console.log('finally')
  }
})

unwrap(result)
