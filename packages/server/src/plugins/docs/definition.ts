import type { ServerDef } from 'server:core'
import { Server, ServerErrors } from 'server:core'
import { definePlugin } from 'std:plugin'
import { fail } from 'std:result'

import { manifestOf } from './internal/manifest'
import { openapiOf } from './internal/openapi'
import { PANEL_HTML } from './internal/panel.gen'
import type { DocsDef } from './types'

/**
 * The docs plugin: the Ozaco Manifest v1 at `<path>/manifest` (services, actions, routes,
 * planes/brands, JSON Schemas, options, errors), an OpenAPI 3.1 rendering of it at
 * `<path>/openapi.json`, and a self-contained panel at `<path>` with try-it. The client
 * consumes the manifest; nothing is fetched from a CDN.
 */
export const Docs = definePlugin<
  ServerDef.PluginContext & { manifest(): DocsDef.Manifest },
  [options?: DocsDef.Options]
>({
  name: 'server-docs',
  version: '0.5.0',
  description: 'Ozaco manifest + docs panel',

  *setup(options) {
    const kernel = yield* Server.context.get()
    if (!kernel) {
      return yield* fail(ServerErrors.Configuration, 'Docs must be installed by createServer')
    }
    const path = (options?.path ?? '/docs').replace(/\/$/u, '')
    const title = options?.title ?? 'docs'
    const manifest = () =>
      manifestOf(kernel, { path, console: kernel.hooks.some(hooks => hooks.name === 'observe') })
    return {
      manifest,
      hooks: {
        name: 'docs',
        *start() {
          const edge = kernel.edge
          if (!edge) {
            return
          }
          yield* edge.actions.raw({
            method: 'GET',
            path: `${path}/manifest`,
            *handler() {
              return Response.json(manifest())
            },
          })
          yield* edge.actions.raw({
            method: 'GET',
            path: `${path}/openapi.json`,
            *handler() {
              return Response.json(openapiOf(manifest()))
            },
          })
          yield* edge.actions.raw({
            method: 'GET',
            path,
            *handler() {
              return new Response(
                PANEL_HTML.replace('<title>ozaco</title>', `<title>${title}</title>`),
                {
                  headers: { 'content-type': 'text/html; charset=utf-8' },
                },
              )
            },
          })
        },
      },
    }
  },
}).build({
  /** The manifest without an edge (tests, codegen). */
  *manifest() {
    return (yield* Docs.context.expect()).manifest()
  },

  /** The manifest as an OpenAPI 3.1 document (also served at `<path>/openapi.json`). */
  *openapi() {
    return openapiOf((yield* Docs.context.expect()).manifest())
  },
})
