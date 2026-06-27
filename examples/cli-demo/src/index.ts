import { attempt, each, main } from 'std:effect'
import { DefaultLogger, Logger } from 'std:logger'
import { install } from 'std:plugin'

import { Terminal } from 'cli:core'
import { BunTerminal } from 'cli:impl/bun'
import { BunIO } from 'std:io/impl/bun'
import { ConsoleTransport } from 'std:logger/transport/console'

await main(function* () {
  yield* install(BunIO)

  yield* install(DefaultLogger)
  yield* install(ConsoleTransport)

  yield* install(BunTerminal)

  const outcome = yield* attempt(function* () {
    return {
      size: yield* Terminal.actions.size(),
      interactive: yield* Terminal.actions.isInteractive(),
    }
  })

  yield* Terminal.actions.session(function* () {
    const keys = yield* Terminal.actions.keys()

    for (const key of yield* each(keys)) {
      console.log(key)

      if (key.ctrl && key.name === 'c') {
        break
      }

      yield* each.next()
    }
  })

  yield* Logger.actions.info(outcome)
})
