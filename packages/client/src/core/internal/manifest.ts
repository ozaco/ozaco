import type { Operation } from 'std:effect'
import { attempt, ensure, until } from 'std:effect'
import { fail, isFailure } from 'std:result'

import { DEFAULT_DOCS_PATH, HEADERS } from '../const'
import { ClientErrors } from '../errors'
import type { ClientDef } from '../types/client'
import type { Helpers } from '../types/helpers'
import type { ManifestDef } from '../types/manifest'
import { failureOf } from '../utils/failure'

import { authorization, networkFailure } from './http'
import {
  carrierOf,
  echoedContext,
  endCall,
  fallbackOf,
  markResponse,
  openCall,
  recordedBy,
  withCarrier,
} from './trace'

/** The manifest exchange: an HTTP failure is the SERVER's answer, not a network error. */
function* fetchManifest(
  ctx: ClientDef.Context,
  { url, headers }: { readonly url: URL; readonly headers: Record<string, string> },
  traced: Helpers.CallSpan | null,
): Operation<ManifestDef.Manifest> {
  const doFetch = ctx.options.fetch ?? fetch
  let response: Response

  try {
    response = yield* until(doFetch(url.toString(), { headers }))
  } catch (error) {
    return yield* networkFailure(error, 'manifest')
  }

  if (traced) {
    yield* markResponse(traced, response)
  }

  // an HTTP failure is decoded like an action reply (its own tag + `status:<code>`), a bare
  // 401/403 read as `client.refused`
  if (!response.ok) {
    return yield* failureOf(response, response.headers.get(HEADERS.requestId), {
      refused: true,
      prefix: `manifest (${url}): `,
      remote: {
        operation: 'manifest',
        recordedIn: recordedBy(traced, yield* echoedContext(response)),
      },
    })
  }

  const manifest = (yield* until(response.json())) as ManifestDef.Manifest

  if (manifest?.manifest !== 'ozaco/2') {
    return yield* fail(ClientErrors.Decode, 'not an ozaco/2 manifest')
  }

  return manifest
}

/**
 * The server's manifest (fetched once, lazily). Traced like a call: one CLIENT span
 * `GET {docsPath}/manifest` when tracing is enabled where it runs, else the ambient context
 * rides along.
 */
export function* manifestOf(ctx: ClientDef.Context): Operation<ManifestDef.Manifest> {
  if (ctx.manifest) {
    return ctx.manifest
  }

  const path = `${ctx.options.docsPath ?? DEFAULT_DOCS_PATH}/manifest`
  const url = new URL(path, ctx.options.url)

  // a server may gate its docs (`Docs.use({ auth })`) — the manifest fetch carries the same
  // bearer every call does
  const bearer = authorization(ctx.options)
  const traced = yield* openCall('GET', url.pathname, url)
  const headers = withCarrier(
    { accept: 'application/json', ...(bearer ? { authorization: bearer } : {}) },
    yield* carrierOf(traced),
  )

  if (!traced) {
    ctx.manifest = yield* fetchManifest(ctx, { url, headers }, null)

    return ctx.manifest
  }

  yield* ensure(fallbackOf(traced))

  let ended = false

  try {
    const outcome = yield* attempt(() => fetchManifest(ctx, { url, headers }, traced))

    ended = true

    if (isFailure(outcome)) {
      yield* endCall(traced, { failure: outcome })

      return yield* outcome
    }

    yield* endCall(traced)
    ctx.manifest = outcome.value

    return outcome.value
  } finally {
    if (!ended) {
      yield* endCall(traced, { cancelled: true })
    }
  }
}

export function* actionOf(
  ctx: ClientDef.Context,
  service: string,
  action: string,
): Operation<ManifestDef.Action> {
  const manifest = yield* manifestOf(ctx)
  const found = manifest.services
    .find(entry => entry.name === service)
    ?.actions.find(entry => entry.kind !== 'socket' && entry.action === action)

  if (!found || found.kind === 'socket') {
    return yield* fail(ClientErrors.NoRoute, `${service}.${action} is not in the manifest`)
  }

  return found
}
