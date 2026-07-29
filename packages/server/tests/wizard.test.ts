import { describe, expect, it } from 'bun:test'

import { Pool } from '@ozaco/db'
import { SqliteDriver } from '@ozaco/db/impl/sqlite'
import { RealtimeDb, table } from '@ozaco/db/realtime'
import { Broker, DefaultBroker, Gateway } from '@ozaco/server/core'
import { BunGateway } from '@ozaco/server/gateway/bun'
import { resource } from '@ozaco/server/wizard'
import { run, suspend } from '@ozaco/std/effect'
import { BunIO } from '@ozaco/std/io/impl/bun'
import { DefaultLogger, LogLevel } from '@ozaco/std/logger'
import { install } from '@ozaco/std/plugin'
import { z } from 'zod'

const wait = (ms: number) =>
  new Promise<void>(resolve => {
    setTimeout(resolve, ms)
  })

const kb = table('kb', {
  title: z.string().min(1),
})

// storage name and address deliberately DIFFER: the table is `kbFiles`, the resource lives at
// `/kb/files` (namespace 'files' nested under the kb collection)
const kbFiles = table('kbFiles', {
  label: z.string().min(1),
})

// SQL-safe table name, hyphenated address
const appRoles = table('appRoles', {
  role: z.string().min(1),
})

const startWizard = async (port: number) => {
  const kbResource = resource(kb, { type: 'crud' })
  const filesResource = resource(kbFiles, { type: 'crud', namespace: 'files', parent: '/kb' })
  const rolesResource = resource(appRoles, { type: 'crud', namespace: 'app-roles' })

  const ready = Promise.withResolvers<void>()
  const task = run(function* () {
    yield* install(BunIO)
    yield* install(DefaultLogger, { level: LogLevel.silent })
    yield* install(DefaultBroker)
    yield* install(BunGateway, { port })
    yield* install(SqliteDriver)
    yield* install(Pool, { connectionUri: ':memory:' })
    yield* install(RealtimeDb, { tables: [kb, kbFiles, appRoles] })
    yield* kbResource.actions.install()
    yield* filesResource.actions.install()
    yield* rolesResource.actions.install()
    yield* Broker.actions.start()
    yield* Gateway.actions.start({ port })
    ready.resolve()
    yield* suspend()
  })
  await ready.promise
  await wait(50)
  return { task, roles: rolesResource }
}

describe('wizard resource addressing', () => {
  it('namespace override + nested mount claims its subtree for every method', async () => {
    const port = 39_401
    const { task, roles } = await startWizard(port)
    try {
      const base = `http://localhost:${port}`

      // namespace IS the identity: service name and route move together, the table name does not leak
      expect(roles.name).toBe('app-roles')
      const list = await fetch(`${base}/app-roles`)
      expect(list.status).toBe(200)
      const missing = await fetch(`${base}/appRoles`)
      expect(missing.status).toBe(404)

      // the nested child answers its own subtree...
      const created = await fetch(`${base}/kb/files`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ label: 'spec.pdf' }),
      })
      expect(created.status).toBe(200)
      const row = (await created.json()) as { _id: string; label: string }
      expect(row.label).toBe('spec.pdf')
      const childList = await fetch(`${base}/kb/files`)
      expect(childList.status).toBe(200)

      // ...and the parent keeps its own param space around it
      const note = await fetch(`${base}/kb`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'a note' }),
      })
      expect(note.status).toBe(200)
      const noteRow = (await note.json()) as { _id: string }
      const byId = await fetch(`${base}/kb/${noteRow._id}`)
      expect(byId.status).toBe(200)

      // The claim is SYMMETRIC: methods the child does not define at its root answer a ROUTE-level
      // 404 instead of falling through to the parent's `:id` routes. The body distinguishes the two
      // regimes — without the guard these dispatched into kb.update/kb.remove and answered
      // `"kb" record "files" not found` (the parent PROCESSED the request, all the way to the DB).
      const patch = await fetch(`${base}/kb/files`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'x' }),
      })
      expect(patch.status).toBe(404)
      const patchBody = await patch.text()
      expect(patchBody).toContain('PATCH:/kb/files')
      expect(patchBody).not.toContain('record')
      const remove = await fetch(`${base}/kb/files`, { method: 'DELETE' })
      expect(remove.status).toBe(404)
      expect(await remove.text()).toContain('DELETE:/kb/files')

      // while the same methods on a REAL parent row keep working
      const removeNote = await fetch(`${base}/kb/${noteRow._id}`, { method: 'DELETE' })
      expect(removeNote.status).toBe(204)
    } finally {
      await task.halt()
    }
  })
})
