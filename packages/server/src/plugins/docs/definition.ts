import { all, createContext, operation, useContext } from 'std:effect'
import { definePlugin, install } from 'std:plugin'
import type { AnyType } from 'std:shared'

import type { RestTransformerOptions } from 'server:core'
import { DEFAULT_REST_METHODS, Rest, Router } from 'server:core'
import type { ActionContext, Service } from 'server:service'
import { defineAction, defineService } from 'server:service'

import { buildOpenAPISpec } from './internal/openapi'
import { buildSwaggerHtml } from './internal/swagger'
import type { CompiledEntry, DocsContext, DocsOptions } from './types'

const CompiledDocs = createContext<CompiledEntry[]>('server:docs:compiled', [])
const DocsRef = createContext<DocsContext>('server:docs:ctx')
const DocsServiceRef = createContext<Service | null>('server:docs:service', null)

const buildDocsService = (docs: DocsContext, spec: AnyType, swagger: string): Service =>
  defineService({
    name: 'docs',
    version: '0.0.1',
    actions: {
      openapi: defineAction(
        {
          settings: [Rest.actions.settings({ method: 'GET', path: docs.openapi })],
        },
        // oxlint-disable-next-line require-yield
        function* () {
          return spec
        },
      ),
      swagger: defineAction(
        {
          settings: [Rest.actions.settings({ method: 'GET', path: docs.swagger })],
        },
        // oxlint-disable-next-line require-yield
        function* (ctx: ActionContext<unknown>) {
          ctx.res.meta['Content-Type'] = 'text/html; charset=utf-8'

          return swagger
        },
      ),
    },
  })

export const Docs = definePlugin({
  name: 'docs',
  version: '0.0.1',
  description: 'documentation service',

  *setup(options: DocsOptions) {
    const ctx: DocsContext = {
      title: options.title ?? 'Docs',
      description: options.description ?? 'Documentation',
      version: options.version ?? '0.0.0',

      openapi: options.openapi ?? '/docs/openapi',
      swagger: options.swagger ?? '/docs/swagger',
    }

    yield* DocsRef.set(ctx)
    yield* CompiledDocs.set([])
    yield* DocsServiceRef.set(null)

    return ctx
  },
}).build({
  from: operation(function* (...services: Service[]) {
    // compile and add to docs on every new service
    const docs = yield* useContext(DocsRef)
    const compiled = (yield* CompiledDocs.get()) ?? []
    const previous = yield* DocsServiceRef.get()

    // parse every method in it and store it CompiledDocs
    const names = new Set(services.map(s => s.name))
    const next: CompiledEntry[] = compiled.filter(e => !names.has(e.service))

    const routerCtx = yield* useContext(Router.context)

    for (const service of services) {
      for (const key of service.getKeys()) {
        const meta = service.meta.get(key)
        if (!meta || meta.isRaw) {
          continue
        }
        if ((meta.allow && !meta.allow.includes(Rest)) || (meta.deny && meta.deny.includes(Rest))) {
          continue
        }

        const settings = yield* all(meta.settings ?? [])

        const actionName = key.split('.').pop()!
        const rest = (settings.find((s: AnyType) => s?.transformer === routerCtx.transformer) ??
          DEFAULT_REST_METHODS[actionName as keyof typeof DEFAULT_REST_METHODS]) as
          | RestTransformerOptions
          | undefined

        if (!rest) {
          continue
        }

        next.push({
          service: service.name,
          key,
          method: rest.method,
          path: `/${service.name}${rest.path === '/' ? '' : rest.path}`,
          meta,
        })
      }
    }

    yield* CompiledDocs.set(next)

    const spec = buildOpenAPISpec(next, docs)
    const swagger = buildSwaggerHtml({ openapi: docs.openapi, title: docs.title })

    // trigger Router.unmount if already exists
    if (previous) {
      yield* Router.actions.unmount(previous)
    }

    // construct new docs service and mount it
    const service = buildDocsService(docs, spec, swagger)
    yield* install(service)
    yield* Router.actions.mount('', service)

    yield* DocsServiceRef.set(service)
  }),
})
