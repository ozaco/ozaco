import { until } from 'std:effect'

import { describe, expect, it } from 'bun:test'

import { manifestSchema } from 'server:plugin/docs'

import { PANEL_HTML } from '../../src/plugin/docs/internal/panel.gen'
import { runScoped } from '../helpers'

import { bootDocsGateway } from './helpers'

describe('docs over real http', () => {
  it('serves the manifest endpoint as a valid OZACO MANIFEST document', async () => {
    const result = await runScoped(function* () {
      const info = yield* bootDocsGateway()
      const res = yield* until(fetch(`${info.url}/docs/manifest`))
      const body = yield* until(res.json())

      return {
        status: res.status,
        type: res.headers.get('content-type'),
        requestId: res.headers.get('x-request-id'),
        body,
      }
    })

    expect(result.status).toBe(200)
    expect(result.type).toContain('application/json')
    expect(result.requestId).toMatch(/^r_/u)

    const manifest = manifestSchema.parse(result.body)

    expect(manifest.app.title).toBe('Fixture API')
    expect(manifest.auth).toEqual({ bearer: true })
    expect(manifest.services['notes']?.prefix).toBe('/notes')
    expect(manifest.services['notes']?.functions['get']?.route?.path).toBe('/notes/:id')
    expect(manifest.services['notes']?.realtime?.path).toBe('/notes/_realtime')
  })

  it('serves the embedded React panel — one self-contained, CDN-free page', async () => {
    const result = await runScoped(function* () {
      const info = yield* bootDocsGateway()
      const res = yield* until(fetch(`${info.url}/docs/`))
      const body = yield* until(res.text())
      const bare = yield* until(fetch(`${info.url}/docs`))

      return {
        status: res.status,
        type: res.headers.get('content-type'),
        body,
        bareStatus: bare.status,
      }
    })

    expect(result.status).toBe(200)
    expect(result.bareStatus).toBe(200)
    expect(result.type).toContain('text/html')
    expect(result.type).toContain('charset=utf-8')

    // byte-exactly the generated panel.gen.ts module the embed step produced
    expect(result.body.length).toBe(PANEL_HTML.length)
    expect(result.body).toBe(PANEL_HTML)

    // the React mount point plus EXACTLY ONE inline script element (the whole app, inlined —
    // the second `<script` occurrence lives inside a JS string, so only one `</script>` exists)
    expect(result.body).toContain('id="root"')
    expect(result.body.split('<script type="module"').length - 1).toBe(1)
    expect(result.body.split('</script>').length - 1).toBe(1)

    // the CDN-free requirement: no element references another origin (bundled JS strings may
    // mention w3.org/react.dev URLS — what matters is that no src/href ATTRIBUTE points out)
    expect(result.body).not.toMatch(/(?:src|href)="https?:/u)
    expect(result.body).not.toContain('<link')
    expect(result.body).not.toContain('@import')
  })

  it('serves routes the manifest documents (the docs page is its own proof)', async () => {
    const result = await runScoped(function* () {
      const info = yield* bootDocsGateway()
      const documented = yield* until(fetch(`${info.url}/notes/42`))
      const note = (yield* until(documented.json())) as { id: string; title: string }

      return { status: documented.status, note }
    })

    expect(result.status).toBe(200)
    expect(result.note).toEqual({ id: '42', title: 'note 42' })
  })
})
