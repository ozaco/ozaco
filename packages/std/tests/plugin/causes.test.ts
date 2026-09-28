import type { Operation } from 'std:effect'
import { attempt, run } from 'std:effect'
import type { Protocol } from 'std:plugin'
import { definePlugin, defineProtocol } from 'std:plugin'
import type { Result } from 'std:result'
import { ResultErrors, appendCauses, fail, isFailure, succeed, unwrap } from 'std:result'
import type { AnyType } from 'std:shared'

import { describe, expect, it } from 'bun:test'

// The plugin runtime wraps every handler, default, impl action, the dispatch and `setup` in
// `guard(fn, ...labels)`: a failure passing through gets that hop's labels appended IN PLACE (the
// same Failure object reaches the caller), inner hop first, after the causes user code gave:
//   protocol handler    `<key>:handler`, `<protocol>@<version>`
//   protocol default    `<key>:default`, `<protocol>@<version>`
//   impl/plugin action  `<key>`, `<impl-or-plugin>@<version>`
//   dispatch            `dispatch`, `<protocol>@<version>`
//   setup               `setup`, `<plugin>@<version>`

let uniq = 0
const name = (base: string) => `${base}-${++uniq}`

/** A failure outcome's tag, message and causes — or `'ok'`. */
const shapeOf = (outcome: Result<unknown>) =>
  isFailure(outcome)
    ? { error: outcome.error, message: outcome.message, causes: outcome.causes }
    : 'ok'

interface IoActions {
  read(path: string): Operation<string>
  readReturned(path: string): Operation<string>
  size(): Operation<number>
  crash(): Operation<never>
  stat(): Operation<number>
  drop(): Operation<never>
}

interface IoHandlers {
  version(): Operation<string>
  refuse(): Operation<never>
}

const makeIo = (options?: { exec?: Protocol.Exec }) => {
  const Io = defineProtocol<{ root: string }, IoActions, IoHandlers>({
    name: name('io'),
    version: '9.9.9',
    exec: options?.exec,
    handlers: {
      *version() {
        // a RETURNED Success still unwraps to its value
        return succeed('v9') as AnyType
      },
      *refuse() {
        return yield* fail('io.refused', 'the handler refused', 'io:handler')
      },
    },
    defaults: {
      *stat() {
        // a RETURNED Failure (not yielded) is still raised
        return fail('io.stat', 'no stat', 'io:stat') as AnyType
      },
      *drop() {
        throw new Error('drop exploded')
      },
    },
  })

  const MemIo = Io.implement({
    name: name('mem-io'),
    version: '1.2.3',
    *setup() {
      return { root: '/mem' }
    },
  }).build({
    *read(path: string) {
      return yield* fail('io.missing', `no ${path}`, 'io:read', `path:${path}`)
    },
    *readReturned(path: string) {
      return fail('io.missing', `no ${path}`, 'io:read-returned') as AnyType
    },
    *size() {
      return succeed(3) as AnyType
    },
    *crash() {
      throw new Error('crash exploded')
    },
    // `stat` / `drop` are left to the protocol defaults
  } as unknown as IoActions)

  return { Io, MemIo }
}

describe('plugin runtime — failures carry the labels of the hops they crossed', () => {
  it('an impl action failure dispatched through the protocol: action, then dispatch labels', async () => {
    const { Io, MemIo } = makeIo()

    const outcome = await run(function* () {
      yield* MemIo.use()

      return yield* Io.actions.read('/a')
    })

    // a tag label is the impl's / protocol's `<name>@<version>`
    expect([MemIo.tag, Io.tag]).toEqual([`${MemIo.name}@1.2.3`, `${Io.name}@9.9.9`])
    expect(shapeOf(outcome)).toEqual({
      error: 'io.missing',
      message: 'no /a',
      causes: ['io:read', 'path:/a', 'read', MemIo.tag, 'dispatch', Io.tag],
    })
  })

  it('an impl action failure through the plugin handle directly gets the same labels', async () => {
    const { Io, MemIo } = makeIo()

    const outcome = await run(function* () {
      yield* MemIo.use()

      return yield* MemIo.actions.read('/b')
    })

    expect(shapeOf(outcome)).toEqual({
      error: 'io.missing',
      message: 'no /b',
      causes: ['io:read', 'path:/b', 'read', MemIo.tag, 'dispatch', Io.tag],
    })
  })

  it("a standalone plugin action failure: the action's labels, then its own dispatch's", async () => {
    const Counter = definePlugin({
      name: name('counter'),
      version: '0.0.1',
      *setup() {
        return { value: 0 }
      },
    }).build({
      *explode() {
        return yield* fail('counter.explode', 'boom', 'counter:explode')
      },
    })

    const outcome = await run(function* () {
      yield* Counter.use()

      return yield* Counter.actions.explode()
    })

    expect(shapeOf(outcome)).toEqual({
      error: 'counter.explode',
      message: 'boom',
      causes: ['counter:explode', 'explode', Counter.tag, 'dispatch', Counter.tag],
    })
  })

  it('a protocol handler failure: `<key>:handler`, then dispatch labels', async () => {
    const { Io } = makeIo()

    const outcome = await run(function* () {
      return yield* Io.actions.refuse()
    })

    expect(shapeOf(outcome)).toEqual({
      error: 'io.refused',
      message: 'the handler refused',
      causes: ['io:handler', 'refuse:handler', Io.tag, 'dispatch', Io.tag],
    })
  })

  it('a default failure: `<key>:default`, then dispatch labels', async () => {
    const { Io, MemIo } = makeIo()

    // with and without an installed impl the default fills the gap
    const bare = await run(function* () {
      return yield* Io.actions.stat()
    })
    const installed = await run(function* () {
      yield* MemIo.use()

      return yield* Io.actions.stat()
    })

    const expected = {
      error: 'io.stat',
      message: 'no stat',
      causes: ['io:stat', 'stat:default', Io.tag, 'dispatch', Io.tag],
    }

    expect(shapeOf(bare)).toEqual(expected)
    expect(shapeOf(installed)).toEqual(expected)
  })

  it('the very Failure user code raised reaches the caller — labelled in place, not a copy', async () => {
    const raised = fail('io.same', 'the same failure', 'io:same')

    const Io = defineProtocol<
      unknown,
      { same(): Operation<never> },
      { handled(): Operation<never> }
    >({
      name: name('io-same'),
      version: '1.0.0',
      handlers: {
        *handled() {
          return yield* raised
        },
      },
      defaults: {
        *same() {
          return yield* raised
        },
      },
    })

    const seen = await run(function* () {
      return {
        viaDefault: yield* attempt(() => Io.actions.same()),
        viaHandler: yield* attempt(() => Io.actions.handled()),
      }
    })

    const { viaDefault, viaHandler } = unwrap(seen)

    expect(viaDefault).toBe(raised)
    expect(viaHandler).toBe(raised)
    // the labels mutate the shared object: every crossing appends its hops again
    expect(raised.causes).toEqual([
      'io:same',
      'same:default',
      Io.tag,
      'dispatch',
      Io.tag,
      'handled:handler',
      Io.tag,
      'dispatch',
      Io.tag,
    ])
  })

  it('a returned Result still unwraps: Success → value, Failure → raised with its causes', async () => {
    const { Io, MemIo } = makeIo()

    const outcome = await run(function* () {
      yield* MemIo.use()

      return {
        handler: yield* Io.actions.version(),
        viaProtocol: yield* Io.actions.size(),
        viaHandle: yield* MemIo.actions.size(),
        returned: shapeOf(yield* attempt(() => Io.actions.readReturned('/r'))),
        returnedViaHandle: shapeOf(yield* attempt(() => MemIo.actions.readReturned('/h'))),
      }
    })

    const labels = ['readReturned', MemIo.tag, 'dispatch', Io.tag]

    expect(unwrap(outcome)).toEqual({
      handler: 'v9',
      viaProtocol: 3,
      viaHandle: 3,
      returned: { error: 'io.missing', message: 'no /r', causes: ['io:read-returned', ...labels] },
      returnedViaHandle: {
        error: 'io.missing',
        message: 'no /h',
        causes: ['io:read-returned', ...labels],
      },
    })
  })

  it('a thrown error is folded into a Failure that carries the labels of its hops', async () => {
    const { Io, MemIo } = makeIo()

    const outcome = await run(function* () {
      yield* MemIo.use()

      return {
        action: yield* attempt(() => Io.actions.crash()),
        viaHandle: yield* attempt(() => MemIo.actions.crash()),
        fallback: yield* attempt(() => Io.actions.drop()),
      }
    })

    const { action, viaHandle, fallback } = unwrap(outcome)

    for (const [failure, message, causes] of [
      [action, 'crash exploded', ['crash', MemIo.tag, 'dispatch', Io.tag]],
      [viaHandle, 'crash exploded', ['crash', MemIo.tag, 'dispatch', Io.tag]],
      [fallback, 'drop exploded', ['drop:default', Io.tag, 'dispatch', Io.tag]],
    ] as const) {
      expect(isFailure(failure)).toBe(true)

      if (isFailure(failure)) {
        // folded by asFailure: tagged, the thrown Error kept as raw — the hops' labels its causes
        expect(failure.error).toBe(ResultErrors.Unknown)
        expect(failure.message).toBe(`Error: ${message}`)
        expect((failure.raw as Error).message).toBe(message)
        expect(failure.causes).toEqual([...causes])
      }
    }
  })

  it('nested protocol hops accumulate: inner hop first, then what each layer appended', async () => {
    const { Io, MemIo } = makeIo()

    const Fs = defineProtocol<unknown, { load(path: string): Operation<string> }>({
      name: name('fs'),
      version: '4.5.6',
    })
    const IoFs = Fs.implement({
      name: name('io-fs'),
      version: '7.8.9',
      *setup() {
        return {}
      },
    }).build({
      *load(path) {
        const read = yield* attempt(() => Io.actions.read(path))

        if (isFailure(read)) {
          // user code decorating the failure: its cause lands after the inner hops' labels
          return yield* appendCauses(read, 'fs:load')
        }

        return read.value
      },
    })

    const outcome = await run(function* () {
      yield* MemIo.use()
      yield* IoFs.use()

      return yield* Fs.actions.load('/x')
    })

    expect(shapeOf(outcome)).toEqual({
      error: 'io.missing',
      message: 'no /x',
      causes: [
        'io:read',
        'path:/x',
        'read',
        MemIo.tag,
        'dispatch',
        Io.tag,
        'fs:load',
        'load',
        IoFs.tag,
        'dispatch',
        Fs.tag,
      ],
    })
  })

  it('a wrapping layer: the inner failure keeps the hops it crossed, the wrapper the later ones', async () => {
    const { Io, MemIo } = makeIo()

    const Fs = defineProtocol<unknown, { load(path: string): Operation<string> }>({
      name: name('fs'),
      version: '4.5.6',
    })
    const IoFs = Fs.implement({
      name: name('io-fs'),
      version: '7.8.9',
      *setup() {
        return {}
      },
    }).build({
      *load(path) {
        const read = yield* attempt(() => Io.actions.read(path))

        if (isFailure(read)) {
          return yield* fail('fs.load', `cannot load ${path}`, read)
        }

        return read.value
      },
    })

    const outcome = await run(function* () {
      yield* MemIo.use()
      yield* IoFs.use()

      return yield* Fs.actions.load('/w')
    })

    expect(isFailure(outcome)).toBe(true)

    if (!isFailure(outcome)) {
      return
    }

    const [inner, ...labels] = outcome.causes

    expect(outcome.error).toBe('fs.load')
    expect(labels).toEqual(['load', IoFs.tag, 'dispatch', Fs.tag])
    expect(shapeOf(inner as Result<unknown>)).toEqual({
      error: 'io.missing',
      message: 'no /w',
      causes: ['io:read', 'path:/w', 'read', MemIo.tag, 'dispatch', Io.tag],
    })
  })

  it('a failing custom exec runs inside the dispatch: only its labels', async () => {
    const { Io, MemIo } = makeIo({
      *exec() {
        return yield* fail('io.no-candidate', 'nothing selected', 'io:exec')
      },
    })

    const outcome = await run(function* () {
      yield* MemIo.use()

      return yield* Io.actions.read('/e')
    })

    expect(shapeOf(outcome)).toEqual({
      error: 'io.no-candidate',
      message: 'nothing selected',
      causes: ['io:exec', 'dispatch', Io.tag],
    })
  })

  it('runtime failures: missing action gets the dispatch labels, not cloneable the setup ones', async () => {
    const { Io, MemIo } = makeIo()
    const OtherIo = Io.implement({
      name: name('other-io'),
      version: '1.0.0',
      *setup() {
        return { root: '/other' }
      },
    }).build({} as IoActions)

    const missing = await run(function* () {
      return yield* Io.actions.read('/m')
    })
    const notCloneable = await run(function* () {
      yield* MemIo.use()

      return yield* OtherIo.use()
    })

    expect(isFailure(missing) && missing.error).toBe('std:plugin.missing-action')
    expect(isFailure(missing) && missing.causes).toEqual(['dispatch', Io.tag])
    expect(isFailure(notCloneable) && notCloneable.error).toBe('std:plugin.protocol-not-cloneable')
    expect(isFailure(notCloneable) && notCloneable.causes).toEqual(['setup', OtherIo.tag])
  })

  it('a failing setup: `setup`, then the plugin tag', async () => {
    const Boot = definePlugin({
      name: name('boot'),
      version: '0.0.1',
      *setup(): Operation<never> {
        return yield* fail('boot.failed', 'could not boot', 'boot:config')
      },
    }).build()

    const outcome = await run(function* () {
      return yield* Boot.use()
    })

    expect(shapeOf(outcome)).toEqual({
      error: 'boot.failed',
      message: 'could not boot',
      causes: ['boot:config', 'setup', Boot.tag],
    })
  })
})
