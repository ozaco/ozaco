import { Trace } from 'std:trace'

import { describe, expect, it } from 'bun:test'

import { parseTraceparent } from '../../src/trace/internal/propagation'

import { traced } from './helpers'

const REMOTE = parseTraceparent('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01')!

const SERVER = { name: '@ozaco/server', version: '9.9.9' }

describe('span scope without an explicit one', () => {
  it('is `app` for a root span with no service — never `@ozaco/std`', async () => {
    const { tracer } = await traced(() =>
      Trace.actions.span('root', () => Trace.actions.span('child', function* () {})),
    )

    expect(tracer.span('root').scope).toEqual({ name: 'app' })
    expect(tracer.span('child').scope).toEqual({ name: 'app' })
  })

  it("is the span's service — its own, else the one it inherits", async () => {
    const { tracer } = await traced(() =>
      Trace.actions.span('root', { service: 'jobs' }, () =>
        Trace.actions.span('inherits', () =>
          Trace.actions.span('own', { service: 'billing' }, function* () {}),
        ),
      ),
    )

    expect(tracer.span('root').scope).toEqual({ name: 'jobs' })
    expect(tracer.span('inherits').scope).toEqual({ name: 'jobs' })
    expect(tracer.span('own').scope).toEqual({ name: 'billing' })
  })

  it("under an ozaco library's span: the service it inherits, else `app`", async () => {
    const { tracer } = await traced(() =>
      Trace.actions.span('dispatch', { scope: SERVER, service: 'demo' }, () =>
        Trace.actions.span('render report', () =>
          Trace.actions.span('library root', { scope: SERVER }, () =>
            Trace.actions.span('user code', function* () {}),
          ),
        ),
      ),
    )

    expect(tracer.span('render report').scope).toEqual({ name: 'demo' })
    expect(tracer.span('user code').scope).toEqual({ name: 'demo' })

    const bare = await traced(() =>
      Trace.actions.span('dispatch', { scope: SERVER }, () =>
        Trace.actions.span('render report', function* () {}),
      ),
    )

    expect(bare.tracer.span('render report').scope).toEqual({ name: 'app' })
    expect(bare.tracer.span('render report').scope.name).not.toStartWith('@ozaco/')
  })

  it("inherits a parent's scope that is not an ozaco library's (version included)", async () => {
    const { tracer } = await traced(() =>
      Trace.actions.span('outer', { scope: { name: 'my-lib', version: '2.0.0' } }, () =>
        Trace.actions.span('inner', function* () {}),
      ),
    )

    expect(tracer.span('inner').scope).toEqual({ name: 'my-lib', version: '2.0.0' })
  })

  it('an explicit scope always wins', async () => {
    const { tracer } = await traced(() =>
      Trace.actions.span('root', { service: 'jobs' }, () =>
        Trace.actions.span('child', { scope: { name: 'db', version: '1' } }, function* () {}),
      ),
    )

    expect(tracer.span('child').scope).toEqual({ name: 'db', version: '1' })
  })

  it('a local root under a remote parent (explicit or pass-through) has no parent scope: `app`', async () => {
    const { tracer } = await traced(() =>
      Trace.actions.span('outer', { scope: { name: 'my-lib' } }, () =>
        Trace.actions.span('handler', { parent: REMOTE }, () =>
          Trace.actions.passThrough(REMOTE, () => Trace.actions.span('carried', function* () {})),
        ),
      ),
    )

    expect(tracer.span('handler').scope).toEqual({ name: 'app' })
    expect(tracer.span('carried').scope).toEqual({ name: 'app' })
  })

  it('startSpan follows the same rule', async () => {
    const { tracer } = await traced(function* () {
      const live = yield* Trace.actions.startSpan('lane', { service: 'queue' })

      yield* live.end()

      const bare = yield* Trace.actions.startSpan('bare')

      yield* bare.end()
    })

    expect(tracer.span('lane').scope).toEqual({ name: 'queue' })
    expect(tracer.span('bare').scope).toEqual({ name: 'app' })
  })
})
