import {
  Broker,
  chunks,
  defineAction,
  defineService,
  Gateway,
  isService,
  useResponse,
} from 'server:core'
import type { Service } from 'server:core'
import { moduleLogger } from 'server:utils'
import { flow, operation } from 'std:effect'
import { definePlugin } from 'std:plugin'

import { buildPanelHtml } from './internal/panel'
import { compile, DocsStateContext } from './internal/state'
import type { DocsState } from './internal/state'
import type { DocsEntry, DocsOptions } from './types'

const DEFAULT_PATH = '/docs'
const ENCODER = new TextEncoder()

/** The mounted `docs` service — the manifest endpoint plus the self-contained panel page. */
const docsService = (state: DocsState): Service =>
  defineService({
    name: 'docs',
    version: '1.0.0',
    description: 'ozaco manifest + docs panel',
    actions: {
      manifest: defineAction(
        {
          title: 'Ozaco Manifest',
          description: 'The typed OZACO MANIFEST v1 document for every published service.',
          kind: 'query',
          route: { method: 'GET', path: '/manifest' },
        },
        function* () {
          return state.manifest ?? (yield* compile(state))
        },
      ),
      panel: defineAction(
        {
          title: 'Docs Panel',
          description: 'Self-contained, CDN-free documentation panel.',
          kind: 'query',
          output: chunks(),
          route: { method: 'GET', path: '/' },
        },
        function* () {
          const manifest = state.manifest ?? (yield* compile(state))
          const html = buildPanelHtml(manifest)
          const response = yield* useResponse()

          response.meta['content-type'] = 'text/html; charset=utf-8'

          return flow<Uint8Array, unknown>(
            (async function* render() {
              yield ENCODER.encode(html)
            })(),
          )
        },
      ),
    },
  })

const DocsImpl = definePlugin<DocsState, [options?: DocsOptions]>({
  name: 'server/docs',
  version: '0.1.0',
  description: 'OZACO MANIFEST v1 compiler + the bundled, CDN-free docs panel',

  *setup(options = {}) {
    const log = yield* moduleLogger('server:docs')

    const state: DocsState = {
      app: {
        title: options.title ?? 'Ozaco API',
        version: options.version ?? '0.0.0',
        description: options.description,
        auth: options.auth ?? false,
      },
      path: options.path ?? DEFAULT_PATH,
      log,
      entries: new Map(),
      manifest: undefined,
    }

    yield* DocsStateContext.set(state)
    yield* log.debug('docs ready', { path: state.path })

    return state
  },
})

/**
 * The docs plugin: compiles mounted services into the OZACO MANIFEST v1 (the OpenAPI replacement
 * of this stack) and serves it together with a self-contained, CDN-free docs panel.
 *
 * ```ts
 * yield* install(Docs, { title: 'My API', version: '1.0.0', auth: true })
 * yield* Docs.actions.from({ prefix: '/todos', service: todos })
 * yield* Docs.actions.mount() // GET /docs (panel) + GET /docs/manifest
 * ```
 */
export const Docs = DocsImpl.build({
  /**
   * Compile (or re-compile) the manifest from real mount entries. Re-callable — later calls
   * merge/replace entries by service name. Plain `Service` values default to `/<name>` prefixes.
   * Fails `server:docs.invalid-manifest` when the generated document breaks the standard.
   */
  from: operation(function* (...entries: (DocsEntry | Service)[]) {
    const state = yield* DocsStateContext.expect()

    for (const entry of entries) {
      const resolved: DocsEntry = isService(entry)
        ? { prefix: `/${entry.name}`, service: entry }
        : entry

      state.entries.set(resolved.service.name, resolved)
    }

    return yield* compile(state)
  }),

  /** The compiled manifest (compiles lazily from the current entries when needed). */
  manifest: operation(function* () {
    const state = yield* DocsStateContext.expect()

    return state.manifest ?? (yield* compile(state))
  }),

  /**
   * Register + mount the `docs` service on the gateway at `options.path` (default `/docs`):
   * `GET <path>/` serves the panel, `GET <path>/manifest` serves the manifest document.
   */
  mount: operation(function* () {
    const state = yield* DocsStateContext.expect()
    const service = docsService(state)

    yield* Broker.actions.register(service)
    yield* Gateway.actions.mount(state.path, service)
    yield* state.log.info('docs mounted', { path: state.path })

    return service
  }),
})
