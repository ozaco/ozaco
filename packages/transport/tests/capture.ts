// oxlint-disable import/exports-last
/** Test helpers: a Logger sink collecting what the transport logs. */
import type { Operation } from 'std:effect'
import { sleep, useContext } from 'std:effect'
import type { LoggerDef } from 'std:logger'
import { LoggerTransport, LogLevel } from 'std:logger'
import { fail } from 'std:result'

import { TRANSPORT_LOGGER } from 'transport:core'

let captures = 0

/** A LoggerTransport collecting every entry (or failing every write, with `broken`). */
export const capture = (broken = false) => {
  captures += 1
  const entries: LoggerDef.Entry[] = []
  const impl = LoggerTransport.implement<
    { name: string; level: LogLevel; entries: LoggerDef.Entry[] },
    []
  >({
    name: `test/transport-capture-${captures}`,
    version: '1.0.0',
    *setup() {
      return { name: 'capture', level: LogLevel.trace, entries }
    },
  })

  const plugin = impl.build({
    *write(entry) {
      if (broken) {
        return yield* fail('test.sink-down', 'the log sink is down')
      }
      ;(yield* useContext(impl.context)).entries.push(entry)
    },
    *flush() {},
    *close() {},
  })

  return { plugin, entries }
}

/** The transport's own lines, as `LEVEL message`. */
export const linesOf = (entries: readonly LoggerDef.Entry[]): string[] =>
  entries
    .filter(entry => entry.bindings.logger === TRANSPORT_LOGGER)
    .map(entry => `${entry.level === LogLevel.warn ? 'WARN' : 'INFO'} ${entry.msg}`)

/** Wait (bounded) until `count` transport lines were logged. */
export function* settled(entries: readonly LoggerDef.Entry[], count: number): Operation<void> {
  for (let round = 0; round < 100 && linesOf(entries).length < count; round += 1) {
    yield* sleep(5)
  }
}
