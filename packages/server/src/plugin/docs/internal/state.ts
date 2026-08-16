import type { BoundLogger } from 'server:utils'
import type { Context, Operation } from 'std:effect'
import { createContext } from 'std:effect'
import { fail } from 'std:result'

import { manifestSchema } from '../const'
import { DocsErrors } from '../errors'
import type { DocsAppInfo, DocsEntry, Manifest } from '../types'

import { buildManifest } from './manifest'

/** Scope-bound docs state — planted by the `Docs` setup, read by every action. */
export interface DocsState {
  readonly app: DocsAppInfo
  readonly path: string
  readonly log: BoundLogger
  readonly entries: Map<string, DocsEntry>
  manifest: Manifest | undefined
}

export const DocsStateContext: Context<DocsState> = createContext<DocsState>('server:docs:state')

/**
 * Build + validate the manifest from the current entries and cache it on the state. The generator
 * and the schema are the same standard — a document that fails to parse is a bug, so the compile
 * fails `server:docs.invalid-manifest` instead of ever serving a broken document.
 */
export function* compile(state: DocsState): Operation<Manifest> {
  const manifest = buildManifest(state.app, [...state.entries.values()])
  const parsed = manifestSchema.safeParse(manifest)

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map(issue => `${issue.path.map(String).join('.')}: ${issue.message}`)
      .join('; ')

    return yield* fail(
      DocsErrors.InvalidManifest,
      `generated manifest does not satisfy manifestSchema — ${issues}`,
    )
  }

  state.manifest = parsed.data

  return parsed.data
}
