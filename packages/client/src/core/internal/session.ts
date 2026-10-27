import type { Future, Operation, Scope } from 'std:effect'
import { attempt, createFuture, race, sleep, toFuture } from 'std:effect'
import { isFailure } from 'std:result'
import type { AnyType } from 'std:shared'

import { ClientErrors } from '../errors'
import type { ClientDef } from '../types/client'

const DEFAULT_KEYS = { access: 'ozaco:access', refresh: 'ozaco:refresh' }
const DEFAULT_SKEW_MS = 60_000

/** How long a failed background renewal waits before the next try (a network fault). */
const RETRY_MS = 5000

/** A JWT's payload, decoded — `null` for anything that is not a readable JWT (the signature is
 * NOT checked: what the token says about its bearer, for the UI; the server verifies). */
const claimsOf = (token: string | null): Record<string, unknown> | null => {
  const payload = token?.split('.')[1]

  if (!payload) {
    return null
  }

  try {
    const parsed: unknown = JSON.parse(atob(payload.replaceAll('-', '+').replaceAll('_', '/')))

    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/** A JWT's `exp` in epoch ms — `0` for anything that is not a readable JWT. */
const expOf = (token: string | null): number => {
  const exp = claimsOf(token)?.['exp']

  return typeof exp === 'number' ? exp * 1000 : 0
}

/**
 * The client's session: the tokens every call carries, where they persist, and the renewal
 * that keeps the access token fresh — before a call that would go out expiring, and in the
 * background while the client lives. One per client; `$setToken` writes into it.
 */
export const createSession = (
  owner: {
    readonly scope: Scope
    /** the `token` option: what answers until the first `set`. */
    readonly given: () => string | undefined
    /** the handle, once built — what `refresh` is handed. */
    readonly client: () => ClientDef.Handle<AnyType>
    /** where a renewal runs (its `refresh` call needs the client's contexts) — the handle's
     * scope; default `scope` (a `lazyClient` session is built before the handle's exists). */
    readonly runIn?: (() => Scope) | undefined
  },
  options: ClientDef.SessionOptions | undefined,
): ClientDef.Session & { needsRenewal(): boolean } => {
  const { scope, given, client } = owner
  const keys = { ...DEFAULT_KEYS, ...options?.keys }
  const skew = options?.skewMs ?? DEFAULT_SKEW_MS
  const storage = options?.storage ?? null
  const memory = new Map<string, string>()
  const listeners = new Set<(status: ClientDef.SessionStatus) => void>()
  let touched = false
  let givenExpiry = 0
  let wake = createFuture<void>()
  let renewing: Future<boolean> | null = null
  // the refresh call is a call too: while one runs, no call renews (it would recurse)
  let inFlight = false

  const read = (key: string): string | null => {
    if (!storage) {
      return memory.get(key) ?? null
    }

    try {
      return storage.getItem(key)
    } catch {
      // a browser blocking site data throws on the accessor, not on the call
      return null
    }
  }

  const write = (key: string, value: string | null): void => {
    if (!storage) {
      if (value === null) {
        memory.delete(key)
      } else {
        memory.set(key, value)
      }

      return
    }

    try {
      if (value === null) {
        storage.removeItem(key)
      } else {
        storage.setItem(key, value)
      }
    } catch {
      // nowhere to persist (site data blocked): the token lives as long as this page does
    }
  }

  const token = (): string | null => read(keys.access) ?? (touched ? null : (given() ?? null))
  const refreshToken = (): string | null => read(keys.refresh)
  const expiresAt = (): number => expOf(token()) || givenExpiry
  const status = (): ClientDef.SessionStatus => (token() === null ? 'anonymous' : 'active')

  const rearm = (): void => {
    const current = wake

    wake = createFuture<void>()
    current.resolve()
  }

  const notify = (): void => {
    const now = status()

    for (const listener of listeners) {
      listener(now)
    }
  }

  const set = (tokens: ClientDef.Tokens): void => {
    touched = true
    write(keys.access, tokens.accessToken)

    // only written when one CAME with the answer: a refresh rotates it, a plain login may not
    if (tokens.refreshToken !== undefined) {
      write(keys.refresh, tokens.refreshToken)
    }

    givenExpiry = tokens.expiresAt ?? 0
    rearm()
    notify()
  }

  const clear = (): void => {
    touched = true
    write(keys.access, null)
    write(keys.refresh, null)
    givenExpiry = 0
    rearm()
    notify()
  }

  const needsRenewal = (): boolean => {
    const at = expiresAt()

    return (
      !inFlight &&
      options?.refresh !== undefined &&
      refreshToken() !== null &&
      at > 0 &&
      at - Date.now() <= skew
    )
  }

  function* renewOnce(): Operation<boolean> {
    const refresh = options?.refresh
    const current = refreshToken()

    if (!refresh || current === null) {
      return false
    }

    inFlight = true

    const outcome = yield* attempt(() => refresh(client(), current))

    inFlight = false

    if (isFailure(outcome)) {
      // the server refused the token: the session is over; a network fault keeps the pair
      if (outcome.error !== ClientErrors.Network) {
        clear()
      }

      return false
    }

    set(outcome.value)

    return true
  }

  /** Single-flight: every caller arriving at an expiring token shares one renewal. */
  const renew = (): Future<boolean> => {
    renewing ??= toFuture(owner.runIn?.() ?? scope, function* () {
      try {
        return yield* renewOnce()
      } finally {
        renewing = null
      }
    })

    return renewing
  }

  if (options?.refresh && options.keepAlive !== false) {
    // a timer, not only a renewal before a call: a tab sitting on a socket makes no call
    scope.run(
      function* () {
        for (;;) {
          const at = expiresAt()

          if (refreshToken() === null || at === 0) {
            yield* wake.future

            continue
          }

          const delay = at - Date.now() - skew

          if (delay > 0) {
            yield* race([sleep(delay), wake.future])

            continue
          }

          if (!(yield* renew())) {
            yield* race([sleep(RETRY_MS), wake.future])
          }
        }
      },
      { detached: true },
    )
  }

  return {
    token,
    refreshToken,
    expiresAt,
    status,
    set,
    clear,
    renew,
    needsRenewal,
    claims: <T extends Record<string, unknown>>() => claimsOf(token()) as T | null,
    subscribe: listener => {
      listeners.add(listener)

      return () => {
        listeners.delete(listener)
      }
    },
  }
}
