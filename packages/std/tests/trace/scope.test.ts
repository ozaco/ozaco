import { ActiveSpan, parseTraceparent, passThrough, span, startSpan } from 'std:trace'

import { describe, expect, it } from 'bun:test'

import { traced } from './helpers'

const REMOTE = parseTraceparent('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01')!

const SERVER = { name: '@ozaco/server', version: '9.9.9' }

describe('span scope without an explicit one', () => {
  it('is `app` for a root span with no service — never `@ozaco/std`', async () => {
    const { tracer } = await traced(() => span('root', () => span('child', function* () {})))

    expect(tracer.span('root').scope).toEqual({ name: 'app' })
    expect(tracer.span('child').scope).toEqual({ name: 'app' })
  })

  it("is the span's service — its own, else the one it inherits", async () => {
    const { tracer } = await traced(() =>
      span('root', { service: 'jobs' }, () =>
        span('inherits', () => span('own', { service: 'billing' }, function* () {})),
      ),
    )

    expect(tracer.span('root').scope).toEqual({ name: 'jobs' })
    expect(tracer.span('inherits').scope).toEqual({ name: 'jobs' })
    expect(tracer.span('own').scope).toEqual({ name: 'billing' })
  })

  it("under an ozaco library's span: the service it inherits, else `app`", async () => {
    const { tracer } = await traced(() =>
      span('dispatch', { scope: SERVER, service: 'demo' }, () =>
        span('render report', () =>
          span('library root', { scope: SERVER }, () => span('user code', function* () {})),
        ),
      ),
    )

    expect(tracer.span('render report').scope).toEqual({ name: 'demo' })
    expect(tracer.span('user code').scope).toEqual({ name: 'demo' })

    const bare = await traced(() =>
      span('dispatch', { scope: SERVER }, () => span('render report', function* () {})),
    )

    expect(bare.tracer.span('render report').scope).toEqual({ name: 'app' })
    expect(bare.tracer.span('render report').scope.name).not.toStartWith('@ozaco/')
  })

  it("inherits a parent's scope that is not an ozaco library's (version included)", async () => {
    const { tracer } = await traced(() =>
      span('outer', { scope: { name: 'my-lib', version: '2.0.0' } }, () =>
        span('inner', function* () {}),
      ),
    )

    expect(tracer.span('inner').scope).toEqual({ name: 'my-lib', version: '2.0.0' })
  })

  it('an explicit scope always wins', async () => {
    const { tracer } = await traced(() =>
      span('root', { service: 'jobs' }, () =>
        span('child', { scope: { name: 'db', version: '1' } }, function* () {}),
      ),
    )

    expect(tracer.span('child').scope).toEqual({ name: 'db', version: '1' })
  })

  it('a local root under a remote parent (explicit or pass-through) has no parent scope: `app`', async () => {
    const { tracer } = await traced(() =>
      span('outer', { scope: { name: 'my-lib' } }, () =>
        span('handler', { parent: REMOTE }, () =>
          ActiveSpan.with(passThrough(REMOTE), () => span('carried', function* () {})),
        ),
      ),
    )

    expect(tracer.span('handler').scope).toEqual({ name: 'app' })
    expect(tracer.span('carried').scope).toEqual({ name: 'app' })
  })

  it('startSpan follows the same rule', async () => {
    const { tracer } = await traced(function* () {
      const live = yield* startSpan('lane', { service: 'queue' })
      yield* live.end()

      const bare = yield* startSpan('bare')
      yield* bare.end()
    })

    expect(tracer.span('lane').scope).toEqual({ name: 'queue' })
    expect(tracer.span('bare').scope).toEqual({ name: 'app' })
  })
})
