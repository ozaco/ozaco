import { DefaultRegistry, defineAction, defineCommand } from 'cli:command'
import { Registry, Spinner } from 'cli:core'
import { DefaultPalette } from 'cli:palette'
import { DefaultPrompt } from 'cli:prompt'
import { DefaultSpinner } from 'cli:spinner'
import { attempt, exit, main, sleep } from 'std:effect'
import { DefaultLogger, Logger } from 'std:logger'
import { install } from 'std:plugin'
import { isFailure } from 'std:result'

import { BunTerminal } from 'cli:terminal/bun'
import { BunIO } from 'std:io/impl/bun'
import { ConsoleTransport } from 'std:logger/transport/console'
import { z } from 'zod'

const Build = defineCommand({
  name: 'build',
  description: 'Build the project',
  actions: {
    default: defineAction(
      {
        description: 'Build the project',
        short: { watch: 'w' },
        args: ['target'],
        input: z.object({ target: z.string().default('.'), watch: z.boolean().default(false) }),
      },
      function* (ctx) {
        const spinner = yield* Spinner.actions.start(`Building ${ctx.target}`)
        yield* sleep(400)
        yield* spinner.succeed(`Built ${ctx.target}${ctx.watch ? ' (watching)' : ''}`)
      },
    ),
  },
  *setup() {},
})

const Remote = defineCommand({
  name: 'remote',
  description: 'Manage the set of tracked repositories',
  actions: {
    add: defineAction(
      {
        description: 'Add a remote named <name> for the repository at <url>',
        args: ['name', 'url'],
        input: z.object({ name: z.string(), url: z.string() }),
      },
      function* (ctx) {
        yield* Logger.actions.info('remote added', { name: ctx.name, url: ctx.url })
      },
    ),
  },
  *setup() {},
})

await main(function* (argv) {
  yield* install(BunIO)
  yield* install(DefaultLogger)
  yield* install(ConsoleTransport)

  yield* install(BunTerminal)
  yield* install(DefaultPalette)
  yield* install(DefaultSpinner)
  yield* install(DefaultPrompt)

  yield* install(DefaultRegistry, {
    name: 'scaffold',
    version: '1.0.0',
    description: 'the stupid content tracker',
  })
  yield* Registry.actions.register(Build)
  yield* Registry.actions.register(Remote)

  const result = yield* attempt(Registry.actions.run(argv))
  if (isFailure(result)) {
    yield* exit(1)
  }
})
