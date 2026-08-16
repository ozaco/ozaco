import type { AnyType } from 'std:shared'

import { describe, expect, it } from 'bun:test'

import { runScoped } from '../helpers'

import { bootWizard, httpJson, targets } from './helpers'

for (const target of targets) {
  describe(`wizard crud over ${target.label}`, () => {
    it('create → 201, get roundtrip, missing → 404 with tag + requestId', async () => {
      const result = await runScoped(function* () {
        const info = yield* bootWizard(target)
        const created = yield* httpJson({
          url: `${info.url}/tasks`,
          method: 'POST',
          body: { title: 'one' },
        })
        const id = String(created.body._id)
        const got = yield* httpJson({ url: `${info.url}/tasks/${id}` })
        const missing = yield* httpJson({ url: `${info.url}/tasks/nope` })

        return { created, got, missing }
      })

      expect(result.created.status).toBe(201)
      expect(result.created.body.title).toBe('one')
      expect(result.created.body._version).toBe(1)
      expect(result.got.status).toBe(200)
      expect(result.got.body.done).toBe(false)
      expect(result.got.body.priority).toBe(0)
      expect(result.missing.status).toBe(404)
      expect(result.missing.body.error).toBe('server:wizard.not-found')
      expect(result.missing.body.requestId).toMatch(/^r_/u)
    })

    it('create with invalid body → 400 db.validation', async () => {
      const result = await runScoped(function* () {
        const info = yield* bootWizard(target)

        return yield* httpJson({ url: `${info.url}/tasks`, method: 'POST', body: { title: 42 } })
      })

      expect(result.status).toBe(400)
      expect(result.body.error).toBe('db.validation')
    })

    it('list: page shape, filter param, facet filter, bad field → 400, bad JSON → 400', async () => {
      const result = await runScoped(function* () {
        const info = yield* bootWizard(target)
        const rows = [
          { title: 'a', done: false, priority: 1 },
          { title: 'b', done: true, priority: 2 },
          { title: 'c', done: false, priority: 3 },
        ]

        for (const row of rows) {
          yield* httpJson({ url: `${info.url}/tasks`, method: 'POST', body: row })
        }

        const filter = (value: unknown) => encodeURIComponent(JSON.stringify(value))
        const all = yield* httpJson({ url: `${info.url}/tasks` })
        const filtered = yield* httpJson({
          url: `${info.url}/tasks?filter=${filter({ op: 'gt', field: 'priority', value: 1 })}`,
        })
        const facet = yield* httpJson({ url: `${info.url}/tasks?done=true` })
        const badField = yield* httpJson({
          url: `${info.url}/tasks?filter=${filter({ op: 'eq', field: 'ghost', value: 1 })}`,
        })
        const badJson = yield* httpJson({ url: `${info.url}/tasks?filter=%7Bnope` })

        return { all, filtered, facet, badField, badJson }
      })

      expect(result.all.status).toBe(200)
      expect(result.all.body.data).toHaveLength(3)
      expect(result.all.body.cursor).toBeNull()
      expect(result.all.body.version).toBeGreaterThan(0)
      expect(result.filtered.body.data.map((row: AnyType) => row.title).toSorted()).toEqual([
        'b',
        'c',
      ])
      expect(result.facet.body.data.map((row: AnyType) => row.title)).toEqual(['b'])
      expect(result.badField.status).toBe(400)
      expect(result.badField.body.error).toBe('db.validation')
      expect(result.badJson.status).toBe(400)
      expect(result.badJson.body.error).toBe('server:wizard.bad-filter')
    })

    it('list pagination: order + cursor walk, limit clamped, page size defaulted', async () => {
      const result = await runScoped(function* () {
        const info = yield* bootWizard(target)

        for (let index = 0; index < 12; index += 1) {
          yield* httpJson({
            url: `${info.url}/tasks`,
            method: 'POST',
            body: { title: `t${index}`, priority: index },
          })
        }

        const first = yield* httpJson({ url: `${info.url}/tasks?limit=4&order=priority` })
        const second = yield* httpJson({
          url: `${info.url}/tasks?limit=4&order=priority&cursor=${encodeURIComponent(String(first.body.cursor))}`,
        })
        const clamped = yield* httpJson({ url: `${info.url}/tasks?limit=999` })
        const defaulted = yield* httpJson({ url: `${info.url}/tasks` })

        return { first, second, clamped, defaulted }
      })

      expect(result.first.body.data.map((row: AnyType) => row.priority)).toEqual([0, 1, 2, 3])
      expect(result.first.body.cursor).not.toBeNull()
      expect(result.second.body.data.map((row: AnyType) => row.priority)).toEqual([4, 5, 6, 7])
      // maxPageSize 10 / pageSize 5 from the fixture crud options
      expect(result.clamped.body.data).toHaveLength(10)
      expect(result.defaulted.body.data).toHaveLength(5)
    })

    it('update: If-Match wrong → 412, right → applied, bad header → 400, missing → 404', async () => {
      const result = await runScoped(function* () {
        const info = yield* bootWizard(target)
        const created = yield* httpJson({
          url: `${info.url}/tasks`,
          method: 'POST',
          body: { title: 'x' },
        })
        const id = String(created.body._id)

        const wrong = yield* httpJson({
          url: `${info.url}/tasks/${id}`,
          method: 'PATCH',
          body: { done: true },
          headers: { 'if-match': '5' },
        })
        const right = yield* httpJson({
          url: `${info.url}/tasks/${id}`,
          method: 'PATCH',
          body: { done: true },
          headers: { 'if-match': '1' },
        })
        const bare = yield* httpJson({
          url: `${info.url}/tasks/${id}`,
          method: 'PATCH',
          body: { title: 'y' },
        })
        const badHeader = yield* httpJson({
          url: `${info.url}/tasks/${id}`,
          method: 'PATCH',
          body: { title: 'z' },
          headers: { 'if-match': 'abc' },
        })
        const missing = yield* httpJson({
          url: `${info.url}/tasks/nope`,
          method: 'PATCH',
          body: { title: 'z' },
        })

        return { wrong, right, bare, badHeader, missing }
      })

      expect(result.wrong.status).toBe(412)
      expect(result.wrong.body.error).toBe('db.conflict')
      expect(result.right.status).toBe(200)
      expect(result.right.body.done).toBe(true)
      expect(result.right.body._version).toBe(2)
      expect(result.bare.status).toBe(200)
      expect(result.bare.body._version).toBe(3)
      expect(result.badHeader.status).toBe(400)
      expect(result.missing.status).toBe(404)
    })

    it('replace: resets omitted fields to defaults, honors If-Match', async () => {
      const result = await runScoped(function* () {
        const info = yield* bootWizard(target)
        const created = yield* httpJson({
          url: `${info.url}/tasks`,
          method: 'POST',
          body: { title: 'orig', done: true, priority: 7, owner: 'ada' },
        })
        const id = String(created.body._id)

        const replaced = yield* httpJson({
          url: `${info.url}/tasks/${id}`,
          method: 'PUT',
          body: { title: 'fresh' },
        })
        const stale = yield* httpJson({
          url: `${info.url}/tasks/${id}`,
          method: 'PUT',
          body: { title: 'nope' },
          headers: { 'if-match': '1' },
        })

        return { replaced, stale }
      })

      expect(result.replaced.status).toBe(200)
      expect(result.replaced.body.title).toBe('fresh')
      expect(result.replaced.body.done).toBe(false)
      expect(result.replaced.body.owner).toBeNull()
      expect(result.replaced.body._version).toBe(2)
      expect(result.stale.status).toBe(412)
    })

    it('remove → 204, then 404; stale If-Match → 412', async () => {
      const result = await runScoped(function* () {
        const info = yield* bootWizard(target)
        const created = yield* httpJson({
          url: `${info.url}/tasks`,
          method: 'POST',
          body: { title: 'gone' },
        })
        const id = String(created.body._id)

        const stale = yield* httpJson({
          url: `${info.url}/tasks/${id}`,
          method: 'DELETE',
          headers: { 'if-match': '5' },
        })
        const removed = yield* httpJson({ url: `${info.url}/tasks/${id}`, method: 'DELETE' })
        const after = yield* httpJson({ url: `${info.url}/tasks/${id}` })
        const again = yield* httpJson({ url: `${info.url}/tasks/${id}`, method: 'DELETE' })

        return { stale, removed, after, again }
      })

      expect(result.stale.status).toBe(412)
      expect(result.removed.status).toBe(204)
      expect(result.removed.body).toBeUndefined()
      expect(result.after.status).toBe(404)
      expect(result.again.status).toBe(404)
      expect(result.again.body.error).toBe('server:wizard.not-found')
    })
  })
}
