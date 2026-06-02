import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { generate } from '../src/index'

describe('@ozaco/unplugin-client — generate', () => {
  it('writes a source client.ts AND a built client.js + client.d.ts (manifest inlined)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ozaco-uc-'))
    try {
      await generate({
        entry: join(import.meta.dir, 'fixture-services.ts'),
        outDir: dir,
        dist: dir,
        clientModule: '@ozaco/server/client',
      })

      const source = readFileSync(join(dir, 'client.ts'), 'utf8')
      expect(source).toContain('"get": { method: "GET", path: "/users/:id" }')
      expect(source).toContain('satisfies ClientDef.Manifest')
      expect(source).toContain('connect<Services>({ ...options, manifest })')

      const js = readFileSync(join(dir, 'client.js'), 'utf8')
      expect(js).toContain('"get": { method: "GET", path: "/users/:id" }')
      expect(js).toContain(
        'export const createClient = options => connect({ ...options, manifest })',
      )
      expect(js).not.toContain('satisfies')

      const dts = readFileSync(join(dir, 'client.d.ts'), 'utf8')
      expect(dts).toContain('export declare const createClient:')
      expect(dts).toContain('Operation<Services, unknown>')
      expect(dts).toContain('"@ozaco/server/client"')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
