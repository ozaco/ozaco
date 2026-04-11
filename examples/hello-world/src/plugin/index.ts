import { debug, enableGlobalDebug, run, useContext } from 'std:effect'
import { install } from 'std:plugin'
import { unwrap } from 'std:result'

import { external, UserPlugin } from './users'

enableGlobalDebug(true)

const result = await run(function* () {
  yield* debug('force-silence')

  yield* install(UserPlugin, 'Hello')

  console.log('context:', yield* useContext(external))

  yield* debug(false)

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
