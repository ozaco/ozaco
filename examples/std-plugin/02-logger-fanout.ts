/**
 * Cloneable protocols + custom exec: a logger whose `log` action fans out to EVERY installed
 * transport, while pinned plugin handles still target one transport.
 *
 * Run: bun run examples/std-plugin/02-logger-fanout.ts
 */
import type { Operation } from 'std:effect'
import { run } from 'std:effect'
import type { Protocol } from 'std:plugin'
import { defineProtocol, install } from 'std:plugin'
import { unwrap } from 'std:result'

interface LoggerContext {
  name: string
  sink: string[]
}

interface LoggerActions {
  log(message: string): Operation<string>
  dump(): Operation<string[]>
}

// exec decides HOW protocol-level calls run across installed impls — here: all of them, in order
const fanout: Protocol.Exec = function* (entries, dispatch) {
  const results: unknown[] = []
  for (const entry of entries) {
    results.push(yield* dispatch(entry))
  }
  return results
}

const Logger = defineProtocol<LoggerActions, LoggerContext>({
  name: 'logger',
  version: '1.0.0',
  cloneable: true, // several transports may be installed side by side
  exec: fanout,
})

const transport = (name: string) =>
  Logger.implement({
    name: `${name}-transport`,
    version: '1.0.0',
    *setup() {
      return { name, sink: [] }
    },
  }).build({
    *log(message) {
      const ctx = yield* Logger.context.expect()
      ctx.sink.push(message)
      return `${ctx.name}:${message}`
    },
    *dump() {
      const ctx = yield* Logger.context.expect()
      return ctx.sink
    },
  })

const ConsoleTransport = transport('console')
const FileTransport = transport('file')

const outcome = await run(function* () {
  yield* install(ConsoleTransport)
  yield* install(FileTransport)

  // protocol-level call → exec fans out to every transport
  console.log('Logger.log =', yield* Logger.actions.log('hello'))

  // pinned calls target one transport, ignoring exec
  console.log('ConsoleTransport.log =', yield* ConsoleTransport.actions.log('direct'))

  // each transport kept its own context (cloneable ⇒ per-impl context value)
  console.log('console sink =', yield* ConsoleTransport.actions.dump())
  console.log('file sink    =', yield* FileTransport.actions.dump())

  return 'done'
})

console.log('run outcome:', unwrap(outcome))
