import { connectClient, createClient } from 'client:core'
import { run, until } from 'std:effect'
import { isFailure, unwrap } from 'std:result'

import { describe, expect, it } from 'bun:test'

import type { Api } from './helpers'
import { bootClientEnv, bootServer, withTimeout } from './helpers'

describe('client calls', () => {
  it('drives typed calls through manifest routes: create, get, list (GET + query args)', async () => {
    const result = unwrap(
      await run(function* () {
        const info = yield* bootServer()

        yield* bootClientEnv()

        const client = yield* createClient<Api>({ url: info.url })

        const first = yield* client.tasks.create({ title: 'write the client' })
        const second = yield* client.tasks.create({ title: 'ship it', done: true })
        const got = yield* client.tasks.get({ id: first._id })
        const page = yield* client.tasks.list({ limit: 1 })
        const done = yield* client.tasks.list({ done: true })

        return { first, second, got, page, done }
      }),
    )

    expect(result.first.title).toBe('write the client')
    expect(result.first.done).toBe(false)
    expect(result.got._id).toBe(result.first._id)

    // list went through the manifest's `GET /tasks` with query args: limit clamps the page …
    expect(result.page.data).toHaveLength(1)
    expect(result.page.cursor).not.toBeNull()
    expect(typeof result.page.version).toBe('number')

    // … and the facet eq-param filters
    expect(result.done.data).toHaveLength(1)
    expect(result.done.data[0]?._id).toBe(result.second._id)
  })

  it('maps failures: original tag, requestId and status breadcrumbs', async () => {
    const outcome = await run(function* () {
      const info = yield* bootServer()

      yield* bootClientEnv()

      const client = yield* createClient<Api>({ url: info.url })

      return yield* client.tasks.get({ id: 'missing' })
    })

    expect(isFailure(outcome)).toBe(true)

    if (isFailure(outcome)) {
      expect(outcome.error).toBe('server:wizard.not-found')
      expect(outcome.message).toContain('tasks/missing')
      expect(outcome.causes.some(cause => cause.startsWith('requestId:'))).toBe(true)
      expect(outcome.causes).toContain('status:404')
    }
  })

  it('sends the bearer token: guarded mutation fails 403 without, succeeds with', async () => {
    const denied = await run(function* () {
      const info = yield* bootServer()

      yield* bootClientEnv()

      const client = yield* createClient<Api>({ url: info.url })

      return yield* client.tasks.finishAll({})
    })

    expect(isFailure(denied)).toBe(true)

    if (isFailure(denied)) {
      expect(denied.error).toBe('server:core.forbidden')
      expect(denied.causes).toContain('status:403')
    }

    const allowed = unwrap(
      await run(function* () {
        const info = yield* bootServer()

        yield* bootClientEnv()

        const client = yield* createClient<Api>({ url: info.url, token: () => 'test-token' })

        yield* client.tasks.create({ title: 'open item' })

        return yield* client.tasks.finishAll({ note: 'sweep' })
      }),
    )

    expect(allowed.finished).toBe(1)
    expect(allowed.note).toBe('sweep')
  })

  it('round-trips through the plain-async connectClient facade', async () => {
    const result = unwrap(
      await run(function* () {
        const info = yield* bootServer()

        const connected = yield* until(
          withTimeout(connectClient<Api>({ url: info.url, token: 'facade-token' })),
        )

        try {
          const created = yield* until(
            withTimeout(connected.client.tasks.create({ title: 'via facade' })),
          )
          const got = yield* until(withTimeout(connected.client.tasks.get({ id: created._id })))
          const finished = yield* until(withTimeout(connected.client.tasks.finishAll({})))

          const rejected = yield* until(
            withTimeout(
              connected.client.tasks.get({ id: 'nope' }).then(
                () => null,
                (error: unknown) => error,
              ),
            ),
          )

          return { created, got, finished, rejected }
        } finally {
          yield* until(connected.close())
        }
      }),
    )

    expect(result.created.title).toBe('via facade')
    expect(result.got._id).toBe(result.created._id)
    expect(result.finished.finished).toBe(1)

    // the facade REJECTS with the Failure object — message and tag included
    expect(isFailure(result.rejected)).toBe(true)
    expect((result.rejected as { error: string }).error).toBe('server:wizard.not-found')
  })
})
