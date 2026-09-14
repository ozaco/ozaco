import { Codec } from 'std:codec'
import { attempt, operation, sleep } from 'std:effect'
import { isSuccess } from 'std:result'
import type { AnyType } from 'std:shared'

import type { Helpers } from '../types/helpers'
import type { WsDef } from '../types/ws'

import { KEEPALIVE_DEFAULTS, OPEN } from './const'

/**
 * Keepalive pump (forked, only when configured): send `payload` through the normal codec framing
 * every `intervalMs` while OPEN. Stops silently if the payload cannot be encoded (e.g. a
 * structured payload with no codec in scope) — it must never raise past the resource.
 */
export const keepAlive = operation(function* (
  session: Helpers.Session,
  keepalive: WsDef.KeepaliveOptions,
) {
  const intervalMs = keepalive.intervalMs ?? KEEPALIVE_DEFAULTS.intervalMs
  const payload = keepalive.payload ?? KEEPALIVE_DEFAULTS.payload

  while (!session.ended) {
    yield* sleep(intervalMs)

    const socket = session.socket
    if (session.ended || !socket || socket.readyState !== OPEN) {
      continue
    }

    const encoded = yield* attempt(() => Codec.actions.encodeFrame(payload, session.options.codec))
    if (!isSuccess(encoded)) {
      return
    }

    socket.send(encoded.value as AnyType)
  }
}, 'ws-keepalive')
