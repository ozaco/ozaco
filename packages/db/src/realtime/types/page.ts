/** Forward/backward cursor window metadata (spec §0.1). */
export interface PageInfo {
  readonly nextCursor: string | null
  readonly prevCursor: string | null
  readonly hasNext: boolean
  readonly hasPrev: boolean
}

/** One page of a cursor-paginated query (spec §0.1 list envelope). */
export interface Page<TDoc> {
  readonly data: readonly TDoc[]
  readonly pageInfo: PageInfo
  readonly resourceVersion: string
  readonly estimatedCount?: number | undefined
}

export interface PaginateOptions {
  readonly cursor?: string | null | undefined
  readonly limit: number
  readonly direction?: 'forward' | 'backward' | undefined
  readonly estimate?: boolean | undefined
}
