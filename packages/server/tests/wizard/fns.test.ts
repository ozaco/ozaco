import { run as runFn } from 'server:wizard'

import { describe, expect, it } from 'bun:test'

import { runScoped } from '../helpers'

import { api, bootWizard, httpJson, targets } from './helpers'

const target = targets[0]!

describe('wizard fns', () => {
  it('custom mutation via its default POST /<res>/<fn> route', async () => {
    const result = await runScoped(function* () {
      const info = yield* bootWizard(target)
      const created = yield* httpJson({
        url: `${info.url}/tasks`,
        method: 'POST',
        body: { title: 'todo' },
      })
      const completed = yield* httpJson({
        url: `${info.url}/tasks/complete`,
        method: 'POST',
        body: { id: created.body._id },
      })
      const missing = yield* httpJson({
        url: `${info.url}/tasks/complete`,
        method: 'POST',
        body: { id: 'nope' },
      })
      const invalid = yield* httpJson({
        url: `${info.url}/tasks/complete`,
        method: 'POST',
        body: { id: 42 },
      })

      return { completed, missing, invalid }
    })

    expect(result.completed.status).toBe(200)
    expect(result.completed.body.done).toBe(true)
    expect(result.missing.status).toBe(404)
    expect(result.missing.body.error).toBe('server:wizard.not-found')
    expect(result.invalid.status).toBe(400)
  })

  it('custom query via POST, aware of table state', async () => {
    const result = await runScoped(function* () {
      const info = yield* bootWizard(target)

      yield* httpJson({ url: `${info.url}/tasks`, method: 'POST', body: { title: 'a' } })
      yield* httpJson({
        url: `${info.url}/tasks`,
        method: 'POST',
        body: { title: 'b', done: true },
      })

      return yield* httpJson({ url: `${info.url}/tasks/stats`, method: 'POST', body: {} })
    })

    expect(result.status).toBe(200)
    expect(result.body).toEqual({ total: 2, done: 1 })
  })

  it('access guard: 403 without the role, 200 with it (custom fn + guarded crud)', async () => {
    const result = await runScoped(function* () {
      const info = yield* bootWizard(target)

      const denied = yield* httpJson({ url: `${info.url}/ops/secret`, method: 'POST', body: {} })
      const allowed = yield* httpJson({
        url: `${info.url}/ops/secret`,
        method: 'POST',
        body: {},
        headers: { 'x-role': 'admin' },
      })
      const lockedDenied = yield* httpJson({ url: `${info.url}/locked` })
      const lockedAllowed = yield* httpJson({
        url: `${info.url}/locked`,
        headers: { 'x-role': 'admin' },
      })

      return { denied, allowed, lockedDenied, lockedAllowed }
    })

    expect(result.denied.status).toBe(403)
    expect(result.denied.body.error).toBe('server:core.forbidden')
    expect(result.denied.body.requestId).toMatch(/^r_/u)
    expect(result.allowed.status).toBe(200)
    expect(result.allowed.body).toEqual({ ok: true })
    expect(result.lockedDenied.status).toBe(403)
    expect(result.lockedAllowed.status).toBe(200)
    expect(result.lockedAllowed.body.data).toEqual([])
  })

  it('run(): typed in-process dispatch inside another handler and from effect land', async () => {
    const result = await runScoped(function* () {
      const info = yield* bootWizard(target)

      // direct: run(api.tasks.create) from plain effect land
      const doc = yield* runFn(api.tasks.create, { title: 'direct' })

      // nested: ops.proxyComplete's handler itself calls run(api.tasks.complete)
      const proxied = yield* httpJson({
        url: `${info.url}/ops/proxyComplete`,
        method: 'POST',
        body: { id: doc._id },
      })
      const after = yield* httpJson({ url: `${info.url}/tasks/${doc._id}` })

      return { doc, proxied, after }
    })

    expect(result.doc.title).toBe('direct')
    expect(result.doc._version).toBe(1)
    expect(result.proxied.status).toBe(200)
    expect(result.proxied.body.done).toBe(true)
    expect(result.after.body.done).toBe(true)
  })
})
