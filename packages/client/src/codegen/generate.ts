import type { Operation } from 'std:effect'
import { until } from 'std:effect'
import { appendCauses, asFailure, fail } from 'std:result'

import { HEADERS } from '../core/const'
import { ClientErrors } from '../core/errors'
import type { ManifestDef } from '../core/types/manifest'
import { failureOf } from '../core/utils/failure'

import { DEFAULT_BANNER, DEFAULT_EFFECT_MODULE, INDENT } from './internal/const'
import {
  callableOf,
  keyText,
  routeText,
  serviceType,
  socketRowType,
  socketsOf,
} from './internal/generate'
import { isRecord } from './internal/schema'
import type { GenerateOptions } from './types'

/**
 * Compile an OZACO MANIFEST v1 into a self-contained `.ts` source: an `Api` interface (one entry
 * per action with `kind`/`input`/`output` as REAL TypeScript types from the JSON Schemas — stream
 * planes become `Flow<T, void>` / `string` / `ReadableStream<Uint8Array>` by brand, `{ declared:
 * true }` degrades to `unknown`) plus an `apiRoutes` const. Use it as
 * `createClient<Api>({ url })`. A non-manifest input fails `client.decode`.
 */
export function* generate(manifest: unknown, options?: GenerateOptions): Operation<string> {
  if (
    !isRecord(manifest) ||
    manifest['manifest'] !== 'ozaco/2' ||
    !Array.isArray(manifest['services'])
  ) {
    return yield* fail(ClientErrors.Decode, 'input is not an OZACO MANIFEST v2 document')
  }

  const document = manifest as unknown as ManifestDef.Manifest
  const services = [...document.services].toSorted((left, right) =>
    left.name.localeCompare(right.name),
  )
  const uses = { flow: false }
  const apiLines: string[] = []
  const routeLines: string[] = []
  const rowLines: string[] = []

  for (const service of services) {
    apiLines.push(`${INDENT}readonly ${keyText(service.name)}: ${serviceType(service, 1, uses)}`)

    const routes = [...callableOf(service)]
      .toSorted((left, right) => left.action.localeCompare(right.action))
      .map(action => `${INDENT}${INDENT}${keyText(action.action)}: ${routeText(action)},`)

    routeLines.push(`${INDENT}${keyText(service.name)}: {`, ...routes, `${INDENT}},`)

    // resource sockets: the ROW type behind `$watch`/`$rows`/`$window`, keyed by service
    for (const socket of socketsOf(service)) {
      const row = socketRowType(socket)

      if (row) {
        rowLines.push(`${INDENT}readonly ${keyText(service.name)}: ${row}`)
      }
    }
  }

  return [
    options?.banner ?? DEFAULT_BANNER,
    ...(uses.flow
      ? ['', `import type { Flow } from '${options?.effectModule ?? DEFAULT_EFFECT_MODULE}'`]
      : []),
    '',
    'export interface Api {',
    ...apiLines,
    '}',
    '',
    'export const apiRoutes = {',
    ...routeLines,
    '} as const',
    '',
    ...(rowLines.length > 0
      ? [
          '/** Realtime resources: the row type each `$watch`/`$rows` feed carries. */',
          'export interface ApiRows {',
          ...rowLines,
          '}',
          '',
        ]
      : []),
  ].join('\n')
}

/** Fetch `GET <url>/docs/manifest` and generate the client source from it. `token` is the
 * bearer a server with `Docs.use({ auth })` expects. Failures read like the runtime client's
 * manifest fetch: an HTTP failure is the server's answer (`failureOf`), only a failed round trip
 * is `client.network` (the platform code or message its message, the platform error its `raw`,
 * a `manifest` cause). */
export function* pull(
  url: string,
  options?: GenerateOptions & { docsPath?: string; token?: string },
): Operation<string> {
  const base = url.endsWith('/') ? url.slice(0, -1) : url
  const target = `${base}${options?.docsPath ?? '/docs'}/manifest`
  let response: Response

  try {
    response = yield* until(
      fetch(target, {
        headers: {
          accept: 'application/json',
          ...(options?.token ? { authorization: `Bearer ${options.token}` } : {}),
        },
      }),
    )
  } catch (error) {
    // a failed round trip, as the runtime client's manifest fetch reports it: a transport fault
    // IS `client.network` (`ClientErrors` classifies it, never `until`'s `std:result.unknown`
    // fold), anything else the fetch rejected with is nested under one
    const fault = asFailure(error, ClientErrors)

    return yield* fault.error === ClientErrors.Network
      ? appendCauses(fault, 'manifest')
      : fail(ClientErrors.Network, 'manifest', fault)
  }

  // the server's answer, decoded like the runtime client's manifest fetch: its own tag (or
  // `client.refused` for a bare 401/403, `http.<code>` otherwise) — never `client.network`
  if (!response.ok) {
    return yield* failureOf(response, response.headers.get(HEADERS.requestId), {
      refused: true,
      prefix: `manifest (${target}): `,
      remote: { operation: 'manifest' },
    })
  }

  const manifest = yield* until(response.json())

  return yield* generate(manifest, options)
}
