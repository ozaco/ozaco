import type { Service } from 'server:core'
import { Gateway } from 'server:core'
import { operation, useContext } from 'std:effect'
import { definePlugin } from 'std:plugin'

import { createOpenAPIAction, createSwaggerAction } from './internal/actions'
import { compileEntries } from './internal/compile'
import { CompiledRef, DocsRef, SpecRef, SwaggerHtmlRef } from './internal/contexts'
import { buildOpenAPISpec, normalizeAuth } from './internal/openapi'
import { buildSwaggerHtml } from './internal/swagger'
import type { DocsDef } from './types'

export const Docs = definePlugin({
  name: 'server/plugin-docs',
  version: '0.0.0',
  description: 'documentation service',

  *setup(options: DocsDef.Options = {}) {
    const ctx: DocsDef.Context = {
      title: options.title ?? 'Docs',
      description: options.description ?? 'Documentation',
      version: options.version ?? '0.0.0',

      openapi: options.openapi ?? '/docs/openapi',
      swagger: options.swagger ?? '/docs/swagger',

      auth: normalizeAuth(options.auth),
    }

    yield* DocsRef.set(ctx)
    yield* CompiledRef.set([])
    yield* SpecRef.set(buildOpenAPISpec([], ctx))
    yield* SwaggerHtmlRef.set(
      buildSwaggerHtml({
        openapi: ctx.openapi,
        title: ctx.title,
        auth: Boolean(ctx.auth),
      }),
    )

    yield* Gateway.actions.mount('', createOpenAPIAction(ctx.openapi))
    yield* Gateway.actions.mount('', createSwaggerAction(ctx.swagger))

    return ctx
  },
}).build({
  from: operation(function* (...services: Service[]) {
    const ctx = yield* useContext(DocsRef)
    yield* useContext(Gateway.context)
    const previous = (yield* CompiledRef.get()) ?? []

    const names = new Set(services.map(s => s.name))
    const kept = previous.filter(entry => !names.has(entry.service))
    const fresh = yield* compileEntries(services, Gateway)

    const next = [...kept, ...fresh]

    yield* CompiledRef.set(next)
    yield* SpecRef.set(buildOpenAPISpec(next, ctx))
  }),
})
