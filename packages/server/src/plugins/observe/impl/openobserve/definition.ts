import type { Helpers, ServerDef } from 'server:core'
import { Server, ServerErrors } from 'server:core'
import { createSink } from 'server:internal'
import { definePlugin } from 'std:plugin'
import { fail } from 'std:result'
import type { AnyType } from 'std:shared'

import pkg from '../../../../../package.json'

import {
  ooDomain,
  ooEvent,
  ooFailure,
  ooLog,
  ooRequest,
  ooRequestUpdate,
  ooSpan,
  post,
} from './internal'
import type { OpenObserveDef } from './types'

const KINDS: readonly OpenObserveDef.StreamKey[] = [
  'requests',
  'spans',
  'logs',
  'failures',
  'events',
  'domain',
]

const ZERO = { sent: 0, dropped: 0, failed: 0 }

/**
 * OpenObserve exporter of what the kernel observes: every request, span, log line, failure and
 * socket/emit event ships to its own stream via the bulk `_json` ingestion API
 * (`/api/<org>/<stream>/_json`) — flat records stamped with `_timestamp` (µs), `service_name`
 * and the node's instance, so the whole `_ob_*` spine is queryable in OpenObserve. Batched in
 * memory; delivery failures are counted (`stats()`), never raised into requests.
 */
export const OpenObserveExporter = definePlugin<
  OpenObserveDef.Context,
  [options: OpenObserveDef.Options]
>({
  name: 'server-observe-openobserve',
  version: pkg.version,
  description: 'OpenObserve exporter of requests, spans, logs, failures and events',

  *setup(options) {
    const kernel = yield* Server.context.get()

    if (!kernel) {
      return yield* fail(
        ServerErrors.Configuration,
        'OpenObserveExporter must be installed by createServer',
      )
    }

    if (!options?.url) {
      return yield* fail(ServerErrors.Configuration, 'OpenObserveExporter needs a base url')
    }

    const base = options.url.replace(/\/$/u, '')
    const org = options.org ?? 'default'
    const doFetch = options.fetch ?? fetch
    const headers: Record<string, string> = { ...options.headers }

    if (options.auth && 'token' in options.auth) {
      headers['authorization'] = `Bearer ${options.auth.token}`
    } else if (options.auth) {
      headers['authorization'] = `Basic ${btoa(`${options.auth.user}:${options.auth.pass}`)}`
    }

    // stamped on every record — one place to slice multi-node data in OpenObserve
    const stamp = {
      service_name: options.serviceName ?? kernel.name,
      service_version: kernel.version,
      service_instance: kernel.instance,
      ...options.resource,
    }

    const sinks = new Map<OpenObserveDef.StreamKey, Helpers.Sink<Record<string, unknown>>>()
    const bodies = options.bodies === true

    for (const kind of KINDS) {
      const stream = options.streams?.[kind] ?? kind

      if (stream === false) {
        continue
      }

      sinks.set(
        kind,
        createSink({
          ...options.batch,
          onError: failure =>
            console.warn(
              `[openobserve] ${kind} delivery failing: ${String((failure as AnyType)?.message ?? failure)}`,
            ),
          *send(rows) {
            yield* post(
              { url: `${base}/api/${org}/${stream}/_json`, headers, fetch: doFetch },
              rows.map(row => ({ ...stamp, ...row })),
            )
          },
        }),
      )
    }

    const hooks: ServerDef.Hooks = {
      name: 'openobserve',
      *observe(event) {
        switch (event.t) {
          case 'request': {
            sinks.get('requests')?.push(ooRequest(event.row, bodies))
            break
          }

          case 'request-update': {
            sinks.get('requests')?.push(ooRequestUpdate(event.update, bodies))
            break
          }

          case 'span': {
            sinks.get('spans')?.push(ooSpan(event.row))
            break
          }

          case 'log': {
            sinks.get('logs')?.push(ooLog(event.row))
            break
          }

          case 'failure': {
            sinks.get('failures')?.push(ooFailure(event.row))
            break
          }

          case 'event': {
            sinks.get('events')?.push(ooEvent(event.row))
            break
          }

          case 'domain': {
            sinks.get('domain')?.push(ooDomain(event.row))
            break
          }

          default: {
            break
          }
        }
      },
      *start() {
        for (const sink of sinks.values()) {
          yield* sink.start()
        }
      },
      *stop() {
        for (const sink of sinks.values()) {
          yield* sink.flush()
        }
      },
    }

    return {
      url: base,
      org,
      stats: () =>
        Object.fromEntries(
          KINDS.map(kind => [kind, sinks.get(kind)?.stats ?? { ...ZERO }]),
        ) as Readonly<
          Record<OpenObserveDef.StreamKey, { sent: number; dropped: number; failed: number }>
        >,
      hooks,
    }
  },
}).build()
