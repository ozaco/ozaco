import type { OptionsDef, ServerDef } from 'server:core'
import { Server, ServerErrors } from 'server:core'
import { OBSERVE_CONSOLE_PATH } from 'server:internal'
// oxlint-disable-next-line no-restricted-imports
import { Auth } from 'server:plugins'
import type { Operation } from 'std:effect'
import { definePlugin } from 'std:plugin'
import { fail } from 'std:result'

import pkg from '../../../package.json'

import { manifestOf } from './internal/manifest'
import { openapiOf } from './internal/openapi'
import { PANEL_HTML } from './internal/panel.gen'
import type { DocsDef } from './types'

/** Request headers as a lower-cased record — what `Auth.actions.authorize` reads. */
const headersOf = (request: Request): Record<string, string> => {
  const headers: Record<string, string> = {}

  // oxlint-disable-next-line unicorn/no-array-for-each
  request.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value
  })

  return headers
}

/**
 * The docs plugin: the Ozaco Manifest v1 at `<path>/manifest` (services, actions, routes,
 * planes/brands, JSON Schemas, options, errors), an OpenAPI 3.1 rendering of it at
 * `<path>/openapi.json`, and a self-contained panel at `<path>` with try-it. The client
 * consumes the manifest; nothing is fetched from a CDN. `auth` gates all three routes behind the
 * `Auth` plugin (bearer in the `authorization` header).
 */
export const Docs = definePlugin<
  ServerDef.PluginContext & { manifest(): DocsDef.Manifest },
  [options?: DocsDef.Options]
>({
  name: 'server-docs',
  version: pkg.version,
  description: 'Ozaco manifest + docs panel',

  *setup(options) {
    const kernel = yield* Server.context.get()
    if (!kernel) {
      return yield* fail(ServerErrors.Configuration, 'Docs must be installed by createServer')
    }
    const path = (options?.path ?? '/docs').replace(/\/$/u, '')
    const title = options?.title ?? 'docs'
    const requirement: OptionsDef.Requirement = options?.auth ?? false

    // resolved at `start`, once every plugin (Auth included) has set up
    let defaultAuth: OptionsDef.Requirement = false
    const manifest = () =>
      manifestOf(kernel, {
        path,

        // what is actually MOUNTED, not what is merely installed: `Observe({ console: false })`
        // used to advertise a dead `/_observe` link in the panel
        console: kernel.routes.some(route => route.path === OBSERVE_CONSOLE_PATH),
        defaultAuth,
      })

    // the gate every docs route runs first: a failure becomes the 401/403 the edge renders
    function* gate(request: Request): Operation<void> {
      if (requirement !== false) {
        yield* Auth.actions.authorize(requirement, headersOf(request))
      }
    }
    return {
      manifest,
      hooks: {
        name: 'docs',
        *start() {
          const auth = yield* Auth.context.get()
          if (requirement !== false && !auth) {
            return yield* fail(
              ServerErrors.Configuration,
              'Docs.use({ auth }) needs the Auth plugin installed',
            )
          }
          defaultAuth = auth?.default ?? false
          const edge = kernel.edge
          if (!edge) {
            return
          }
          yield* edge.actions.raw({
            method: 'GET',
            path: `${path}/manifest`,
            *handler(request) {
              yield* gate(request)
              return Response.json(manifest())
            },
          })
          yield* edge.actions.raw({
            method: 'GET',
            path: `${path}/openapi.json`,
            *handler(request) {
              yield* gate(request)
              return Response.json(openapiOf(manifest()))
            },
          })
          yield* edge.actions.raw({
            method: 'GET',
            path,
            *handler(request) {
              yield* gate(request)
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
