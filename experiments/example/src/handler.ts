import { Err } from '@ozaco/std/results'

process
  .on('unhandledRejection', (_reason, p) => {
    if (p instanceof Err) {
      // biome-ignore lint/suspicious/noConsole: <explanation>
      console.error({ ...p })
    } else {
      // biome-ignore lint/suspicious/noConsole: <explanation>
      console.error(p)
    }
  })
  .on('uncaughtException', err => {
    if (err instanceof Err) {
      // biome-ignore lint/suspicious/noConsole: <explanation>
      console.error({ ...err })
    } else {
      // biome-ignore lint/suspicious/noConsole: <explanation>
      console.error(err)
    }

    process.exit(1)
  })
