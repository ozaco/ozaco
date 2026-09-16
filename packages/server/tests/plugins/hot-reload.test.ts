/**
 * `HotReload` — the declarations module is re-evaluated (its imports too, on Bun) and swapped
 * into the running node; a broken save keeps the last good declarations; the watcher turns a
 * file change into a reload by itself.
 */
import type { ServiceDef } from 'server:core'
import { action, createServer, refs, service } from 'server:core'
import { HotReload, HotReloadErrors } from 'server:plugins'
import type { Operation } from 'std:effect'
import { attempt, run, sleep } from 'std:effect'
import { IO } from 'std:io'
import { unwrap } from 'std:result'
import type { AnyType } from 'std:shared'

import { describe, expect, it } from 'bun:test'

import { z } from 'zod'

import { storage } from '../helpers'

// the fs.watch fallback answers within milliseconds; a Watchman daemon may take longer to settle
process.env['STD_WATCHMAN'] = 'off'

type Hot = ServiceDef.Service<
  'hot',
  { greet: ServiceDef.Action<z.ZodObject<{ name: z.ZodString }>, z.ZodString> }
>

/** A throwaway declarations module under the package (the `server:*` aliases resolve there),
 * split in two files so a change in the DEPENDENCY proves the subgraph is re-evaluated. */
function* scaffold(name: string): Operation<{ dir: string; entry: string; dep: string }> {
  const dir = yield* IO.actions.join(import.meta.dirname, '..', '..', '.ozaco', 'hot-reload', name)
  yield* IO.actions.emptyDir(dir)
  const entry = yield* IO.actions.join(dir, 'services.ts')
  const dep = yield* IO.actions.join(dir, 'greeting.ts')
  yield* IO.actions.write(
    entry,
    [
      `import { action, service } from 'server:core'`,
      `import { z } from 'zod'`,
      `import { GREETING } from './greeting'`,
      ``,
      `export const services = [`,
      `  service('hot', {`,
      `    greet: action.query(`,
      `      { input: z.object({ name: z.string() }), output: z.string() },`,
      `      function* ({ input }) {`,
      `        return \`\${GREETING}, \${input.name}\``,
      `      },`,
      `    ),`,
      `  }),`,
      `]`,
      ``,
    ].join('\n'),
  )
  yield* setGreeting(dep, 'hello')
  return { dir, entry, dep }
}

function* setGreeting(dep: string, greeting: string): Operation<void> {
  yield* IO.actions.write(dep, `export const GREETING = '${greeting}'\n`)
}

describe('plugins — hot reload', () => {
  it('re-evaluates the entry AND its imports, swaps the declarations, survives a broken save', async () => {
    unwrap(
      await run(function* () {
        yield* storage()
        const files = yield* scaffold('manual')

        const server = yield* createServer({
          services: [],
          plugins: [HotReload.use({ entry: files.entry, watch: [files.dir] })],
        })
        const greet = refs<Hot>('hot').greet

        // the first reload brings the declarations in
        const first = yield* HotReload.actions.reload()
        expect(first.added).toEqual(['hot'])
        expect(yield* server.call(greet, { name: 'a' })).toBe('hello, a')
        expect((yield* HotReload.actions.status()).generation).toBe(1)

        // a change in the DEPENDENCY reaches the handler: the subgraph was re-evaluated
        yield* setGreeting(files.dep, 'hi')
        const second = yield* HotReload.actions.reload()
        expect(second.replaced).toEqual(['hot'])
        expect(yield* server.call(greet, { name: 'a' })).toBe('hi, a')

        // a broken save: the reload fails, the last good declarations keep serving
        yield* IO.actions.write(files.dep, `export const GREETING = = 'broken'\n`)
        const broken = yield* attempt(HotReload.actions.reload())
        expect((broken as AnyType).error).toBe(HotReloadErrors.Load)
        expect((yield* HotReload.actions.status()).lastError).toContain(HotReloadErrors.Load)
        expect(yield* server.call(greet, { name: 'a' })).toBe('hi, a')

        // …and the next good save recovers
        yield* setGreeting(files.dep, 'hey')
        yield* HotReload.actions.reload()
        expect(yield* server.call(greet, { name: 'a' })).toBe('hey, a')
        expect((yield* HotReload.actions.status()).lastError).toBeNull()

        // a module that does not export the declarations is a configuration failure
        yield* IO.actions.write(files.entry, `export const nothing = 1\n`)
        const none = yield* attempt(HotReload.actions.reload())
        expect((none as AnyType).error).toBe('server.configuration')
        expect(yield* server.call(greet, { name: 'a' })).toBe('hey, a')

        yield* IO.actions.rm(files.dir, { recursive: true, force: true })
      }),
    )
  })

  it('watches the roots: a save becomes a reload on its own', async () => {
    const seen: string[][] = []
    unwrap(
      await run(function* () {
        yield* storage()
        const files = yield* scaffold('watched')
        const server = yield* createServer({
          services: [],
          plugins: [
            HotReload.use({
              entry: files.entry,
              watch: [files.dir],
              debounceMs: 30,
              *onReload(report) {
                seen.push([...(report.replaced.length > 0 ? report.replaced : report.added)])
              },
            }),
          ],
        })
        yield* server.start()
        const greet = refs<Hot>('hot').greet
        yield* HotReload.actions.reload()
        expect(yield* server.call(greet, { name: 'a' })).toBe('hello, a')
        expect((yield* HotReload.actions.status()).watching).toBe(true)

        // let the watcher settle, then save
        yield* sleep(100)
        yield* setGreeting(files.dep, 'watched')

        const deadline = Date.now() + 5000
        let answer = ''
        while (answer !== 'watched, a' && Date.now() < deadline) {
          yield* sleep(50)
          answer = yield* server.call(greet, { name: 'a' })
        }
        expect(answer).toBe('watched, a')
        expect(seen.at(-1)).toEqual(['hot'])

        yield* server.stop()
        expect((yield* HotReload.actions.status()).watching).toBe(false)
        yield* IO.actions.rm(files.dir, { recursive: true, force: true })
      }),
    )
  })

  it('takes a custom loader instead of importing', async () => {
    unwrap(
      await run(function* () {
        yield* storage()
        let greeting = 'one'
        const server = yield* createServer({
          services: [],
          plugins: [
            HotReload.use({
              entry: 'unused.ts',
              *load() {
                return [
                  service('hot', {
                    greet: action.query({ output: z.string() }, function* () {
                      return greeting
                    }),
                  }),
                ]
              },
            }),
          ],
        })
        const greet =
          refs<ServiceDef.Service<'hot', { greet: ServiceDef.Action<undefined, z.ZodString> }>>(
            'hot',
          ).greet
        yield* HotReload.actions.reload()
        expect(yield* server.call(greet)).toBe('one')
        greeting = 'two'
        yield* HotReload.actions.reload()
        expect(yield* server.call(greet)).toBe('two')
      }),
    )
  })
})
