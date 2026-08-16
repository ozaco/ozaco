import type { BoundLogger } from 'server:utils'
import type { AnyType } from 'std:shared'

export interface StarRocksOptions {
  /** FE HTTP address, e.g. `http://127.0.0.1:8030` — Stream Load ingest goes here. */
  readonly feUrl: string
  /** MySQL-protocol address as `host:port`; defaults to the `feUrl` host on port `9030`. */
  readonly queryUrl?: string | undefined
  readonly database: string
  /** Default `root`. */
  readonly user?: string | undefined
  /** Default `''`. */
  readonly password?: string | undefined
  /** Stream Load label prefix (labels are `${prefix}-${table}-${unique}`). */
  readonly labelPrefix?: string | undefined
  /**
   * Optional BE base URL override for the Stream Load redirect. The FE 307-redirects every load to
   * a BE using the address the BE registered with — behind NAT/docker port mappings that address is
   * unreachable from the client, so when set, the redirect's host:port is replaced with this URL
   * (path and query are kept). Leave unset on a flat network.
   */
  readonly beUrl?: string | undefined
}

/** Store plumbing types — grouped (`Result.Failure` pattern); reach them as `StarRocks.X`. */
export namespace StarRocks {
  /** The minimal `mysql2/promise` pool surface we use — kept structural so the optional peer never
   * becomes a type-level dependency. */
  export interface PoolLike {
    query(statement: string, params?: readonly unknown[]): Promise<AnyType>
    end(): Promise<void>
  }

  export interface Context {
    readonly feUrl: string
    readonly database: string
    /** Pre-encoded `Basic` credential (base64 of `user:password`). */
    readonly credentials: string
    readonly labelPrefix: string
    readonly beUrl: string | undefined
    readonly pool: PoolLike
    readonly log: BoundLogger
  }

  /** The JSON body a Stream Load PUT resolves to (subset). */
  export interface StreamLoadResponse {
    readonly Status?: string
    readonly Message?: string
    readonly Label?: string
    readonly NumberLoadedRows?: number
    readonly ErrorURL?: string
  }
}
