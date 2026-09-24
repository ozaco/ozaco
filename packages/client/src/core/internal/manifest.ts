import type { Operation } from 'std:effect'
import { until } from 'std:effect'
import { fail, isFailure } from 'std:result'

import { DEFAULT_DOCS_PATH, HEADERS } from '../const'
import { ClientErrors } from '../errors'
import type { ClientDef } from '../types/client'
import type { ManifestDef } from '../types/manifest'

import { failureOf } from './decode'
import { authorization } from './http'

export function* manifestOf(ctx: ClientDef.Context): Operation<ManifestDef.Manifest> {
  if (ctx.manifest) {
    return ctx.manifest
  }

  const url = new URL(`${ctx.options.docsPath ?? DEFAULT_DOCS_PATH}/manifest`, ctx.options.url)
  const doFetch = ctx.options.fetch ?? fetch

  // a server may gate its docs (`Docs.use({ auth })`) — the manifest fetch carries the same
  // bearer every call does
  const bearer = authorization(ctx.options)
  const headers: Record<string, string> = {
    accept: 'application/json',
    ...(bearer ? { authorization: bearer } : {}),
  }
  let response: Response

  try {
    response = yield* until(doFetch(url.toString(), { headers }))
  } catch (error) {
    const failure = isFailure(error) ? error : null

    return yield* fail(
      ClientErrors.Network,
      `manifest: ${failure ? `${String(failure.error ?? 'failure')}${failure.message ? `: ${failure.message}` : ''}` : String(error)}`,
      ...(failure ? failure.causes.map(String) : []),
    )
  }

  // an HTTP failure is the SERVER's answer, not a network error: decoded like an action reply
  // (its own tag + `status:<code>`), a bare 401/403 read as `client.refused`
  if (!response.ok) {
    return yield* failureOf(response, response.headers.get(HEADERS.requestId), {
      refused: true,
      prefix: `manifest (${url}): `,
    })
  }

  const manifest = (yield* until(response.json())) as ManifestDef.Manifest

  if (manifest?.manifest !== 'ozaco/2') {
    return yield* fail(ClientErrors.Decode, 'not an ozaco/2 manifest')
  }

  ctx.manifest = manifest

  return manifest
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
