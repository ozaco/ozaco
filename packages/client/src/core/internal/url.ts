import type { ClientDef } from '../types/client'

/** A route's absolute URL: `options.prefix` (a mount path such as `/api`) before the path, both
 * on `options.url`. A path is always absolute on the server, so `new URL(path, url)` alone
 * would drop any mount the base carried. */
export const urlOf = (options: ClientDef.Options, path: string): URL => {
  const prefix = options.prefix ? options.prefix.replace(/\/+$/u, '') : ''
  const absolute = path.startsWith('/') ? path : `/${path}`

  return new URL(`${prefix}${absolute}`, options.url)
}
