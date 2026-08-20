import type { AsyncSession, ConnectedSession } from '@ozaco/client'
import { connectSession } from '@ozaco/client'
import { useEffect, useState } from 'react'

import { getToken } from '../lib'

/**
 * THE PANEL'S DATA LAYER IS `@ozaco/client`.
 *
 * One `connectSession` per (base, docsPath): the client owns an effect scope with `FetchClient`,
 * `JsonCodec` and `Ws` installed, and hands back the Promise-facing inspector session — manifest
 * resolution, manifest-addressed requests with full response metadata, the shared realtime link
 * with its frame timeline, and the SSE flavor. The panel adds no protocol code of its own.
 *
 * The token is read through a resolver, so changing it in Settings takes effect on the very next
 * request without reconnecting; changing the BASE tears the old session down (closing every socket
 * and stream with its scope) and dials a new one.
 */

/** Same-origin means relative urls; realtime still needs an absolute origin to dial. */
const originOf = (base: string): string => {
  if (base !== '') {
    return base
  }

  return typeof location === 'undefined' ? '' : location.origin
}

export interface PanelSession {
  readonly session: AsyncSession | null
  /** Dial failure — the session could not even be created (never a request-level failure). */
  readonly error: string | null
}

export const usePanelSession = (base: string, docsPath: string): PanelSession => {
  const [state, setState] = useState<PanelSession>({ session: null, error: null })

  useEffect(() => {
    let disposed = false
    let connected: ConnectedSession | undefined

    setState({ session: null, error: null })

    void connectSession({ url: originOf(base), docsPath, token: () => getToken() })
      // oxlint-disable-next-line promise/always-return
      .then(next => {
        connected = next

        if (disposed) {
          void next.close()

          return
        }

        setState({ session: next.session, error: null })
      })
      .catch((error: unknown) => {
        if (!disposed) {
          setState({ session: null, error: messageOf(error) })
        }
      })

    return () => {
      disposed = true
      void connected?.close()
    }
  }, [base, docsPath])

  return state
}

/** Client failures are `Result.Failure` OBJECTS, not `Error`s — render both shapes. */
export const messageOf = (error: unknown): string => {
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const failure = error as { message: unknown; error?: unknown }
    const tag = typeof failure.error === 'string' ? `${failure.error}: ` : ''

    return `${tag}${String(failure.message)}`
  }

  return String(error)
}
