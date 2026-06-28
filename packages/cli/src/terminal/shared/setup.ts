import type { InputStream, OutputStream, TerminalDef } from 'cli:core'
import { attempt, useContext } from 'std:effect'
import { IO } from 'std:io'
import { Logger } from 'std:logger'
import { isFailure, isSuccess } from 'std:result'

export const nodelikeSetup = function* (options: TerminalDef.Options = {}) {
  const input = options.input ?? (process.stdin as unknown as InputStream)
  const output = options.output ?? (process.stdout as unknown as OutputStream)
  const error = options.error ?? (process.stderr as unknown as OutputStream)
  const encoding = options.encoding ?? 'utf8'

  const interactive =
    options.interactive ??
    Boolean(input.isTTY && output.isTTY && typeof input.setRawMode === 'function')

  // check io plugin
  const isIOInstalled = yield* attempt(useContext(IO))

  if (isFailure(isIOInstalled)) {
    const isLoggerInstalled = yield* attempt(useContext(Logger))
    const message = 'IO plugin is required by cli'

    if (isSuccess(isLoggerInstalled)) {
      yield* Logger.actions.warn(message)
    } else {
      console.warn(message)
    }

    yield* isIOInstalled
  }

  return { input, output, error, interactive, encoding }
}
