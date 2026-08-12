/**
 * Hooks + scoped overrides: because the plugin system dispatches through the effect api layer,
 * every hook (`around`, `before`, `after`, `error`) is scope-scoped middleware — it applies to the
 * current scope and its children, and reverts when the scope closes. Perfect for tests.
 *
 * Run: bun run examples/std-plugin/03-scoped-override.ts
 */
import type { Operation } from 'std:effect'
import { constant, run, scoped } from 'std:effect'
import { defineProtocol, install } from 'std:plugin'
import { unwrap } from 'std:result'

interface HttpContext {
  base: string
}

interface HttpActions {
  get(path: string): Operation<string>
}

const Http = defineProtocol<HttpContext, HttpActions, { describe(): Operation<string> }>({
  name: 'http',
  version: '1.0.0',
  // protocol-level handler: runs exactly once, never tied to an impl
  handlers: {
    *describe() {
      return 'http protocol v1'
    },
  },
})

const RealHttp = Http.implement({
  name: 'real-http',
  version: '1.0.0',
  *setup() {
    return { base: 'https://api.example.com' }
  },
}).build({
  *get(path) {
    const ctx = yield* Http.context.expect()
    return `GET ${ctx.base}${path} -> 200`
  },
})

const outcome = await run(function* () {
  yield* install(RealHttp)

  console.log(yield* Http.actions.describe())
  console.log('real       :', yield* Http.actions.get('/users'))

  // scoped test fake: override `get` without touching the impl; reverted after the scope
  const faked = yield* scoped(function* () {
    yield* Http.around({
      get: () => constant('FAKE 200') as Operation<string>,
    })

    return yield* Http.actions.get('/users')
  })
  console.log('faked      :', faked)
  console.log('after scope:', yield* Http.actions.get('/users'))

  // observability hooks
  yield* Http.before({
    *get(args) {
      console.log('before hook:', 'about to GET', args[0])
    },
  })
  yield* Http.after({
    *get(result) {
      return `${result} (traced)`
    },
  })

  console.log('with hooks :', yield* Http.actions.get('/orders'))

  return 'done'
})

console.log('run outcome:', unwrap(outcome))
