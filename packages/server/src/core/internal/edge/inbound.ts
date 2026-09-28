import type { TraceDef } from 'std:trace'

import type { Helpers } from '../../types/helpers'
import type { ServerDef } from '../../types/server'
import { SAMPLED } from '../const'

export const trusts = (settings: ServerDef.TraceSettings, request: Request): boolean => {
  if (!settings.trust) {
    return false
  }

  try {
    return settings.trust(request) === true
  } catch {
    // a throwing predicate trusts nobody
    return false
  }
}

/** `server.address`: the URL's host — an IPv6 literal WITHOUT its brackets (`::1`, as semconv
 * and std fetch's CLIENT spans have it; `url.hostname` keeps them). */
export const addressOf = (url: URL): string => {
  const { hostname } = url

  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
}

export const portOf = (url: URL): number => {
  if (url.port) {
    return Number(url.port)
  }

  return url.protocol === 'https:' || url.protocol === 'wss:' ? 443 : 80
}

/** The inbound policy under a trust verdict (see {@link inboundOf}). */
export const policyOf = (
  settings: ServerDef.TraceSettings,
  inbound: TraceDef.SpanContext | null,
  verdict: Pick<Helpers.Inbound, 'trusted' | 'marked'>,
): Helpers.Inbound => {
  const { trusted } = verdict
  const marked = verdict.marked || inbound?.ozaco === true
  const mode = trusted || marked ? 'continue' : settings.inbound

  if (!inbound || mode === 'ignore') {
    return { parent: null, links: [], trusted, marked, mode }
  }

  if (mode === 'continue') {
    const honoured = trusted || settings.inbound === 'continue'

    return {
      parent: honoured ? inbound : { ...inbound, flags: inbound.flags | SAMPLED },
      links: [],
      trusted,
      marked,
      mode,
    }
  }

  return {
    parent: null,
    links: [{ context: inbound, attributes: { 'ozaco.link.reason': 'remote.parent' } }],
    trusted,
    marked,
    mode,
  }
}

/**
 * {@link inboundOf} for a WS frame's own context, under its upgrade's verdict: the `trust`
 * predicate is not asked again, and a marked upgrade (`ozaco=1`) marks every frame.
 */
export const frameInboundOf = (
  kernel: ServerDef.Context,
  inbound: TraceDef.SpanContext | null,
  upgrade: Pick<Helpers.Inbound, 'trusted' | 'marked'>,
): Helpers.Inbound => policyOf(kernel.telemetry.trace, inbound, upgrade)

/** Count one request into `kernel.active` (`http.server.active_requests`); the returned
 * function takes it out again — once, however often it is called. */
export const enterActive = (
  kernel: ServerDef.Context,
  method: string,
  scheme: string,
): (() => void) => {
  const key = `${method} ${scheme}`
  const entry = kernel.active.get(key) ?? { method, scheme, count: 0 }

  entry.count += 1
  kernel.active.set(key, entry)

  let open = true

  return () => {
    if (open) {
      open = false
      entry.count -= 1
    }
  }
}
