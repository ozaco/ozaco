import type { Adapter } from 'db:core'

const POSTGRES_PORT = 5432

/**
 * The telemetry identity of a Postgres adapter from its connection string: the database name
 * (`db.namespace`; the user name — Postgres' own default — when the URL names none) and the
 * server's address and port. An unparsable URL still says `postgresql`.
 */
export const postgresTelemetry = (url: string): Adapter.Telemetry => {
  let parsed: URL

  try {
    parsed = new URL(url)
  } catch {
    return { system: 'postgresql', namespace: 'postgres' }
  }

  const database = decodeURIComponent(parsed.pathname.replace(/^\//u, ''))
  const user = decodeURIComponent(parsed.username)
  const address = parsed.hostname.replace(/^\[(.*)\]$/u, '$1')

  return {
    system: 'postgresql',
    namespace: database || user || 'postgres',
    ...(address ? { address, port: parsed.port ? Number(parsed.port) : POSTGRES_PORT } : {}),
  }
}
