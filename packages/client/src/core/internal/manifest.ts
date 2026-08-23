// oxlint-disable import/exports-last
import type { Operation } from 'std:effect'
import { until } from 'std:effect'
import { fail } from 'std:result'

import { DEFAULT_DOCS_PATH } from '../const'
import { ClientErrors } from '../errors'
import type { ClientDef } from '../types/client'
import type { ManifestDef } from '../types/manifest'

export function* manifestOf(ctx: ClientDef.Context): Operation<ManifestDef.Manifest> {
  if (ctx.manifest) {
    return ctx.manifest
  }

  const url = new URL(`${ctx.options.docsPath ?? DEFAULT_DOCS_PATH}/manifest`, ctx.options.url)
  const doFetch = ctx.options.fetch ?? fetch
  let response: Response

  try {
    response = yield* until(doFetch(url.toString(), { headers: { accept: 'application/json' } }))
  } catch (error) {
    return yield* fail(ClientErrors.Network, `manifest: ${String(error)}`)
  }

  if (!response.ok) {
    return yield* fail(ClientErrors.Network, `manifest: ${response.status} at ${url}`)
  }

  const manifest = (yield* until(response.json())) as ManifestDef.Manifest

  if (manifest?.manifest !== 'ozaco/1') {
    return yield* fail(ClientErrors.Decode, 'not an ozaco/1 manifest')
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
    ?.actions.find(entry => entry.action === action)

  if (!found) {
    return yield* fail(ClientErrors.NoRoute, `${service}.${action} is not in the manifest`)
  }

  return found
}
