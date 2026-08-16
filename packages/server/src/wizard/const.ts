/** Brand for fn declarations created by `query`/`mutation`/`action`. */
export const WIZARD_FN = Symbol.for('server:wizard:fn')

/** Broker event the change-bus bridge publishes/subscribes db invalidations on. */
export const DB_CHANGE_EVENT = '$db.change'

/** Default `crud` list page size. */
export const DEFAULT_PAGE_SIZE = 50

/** Default `crud` list page-size ceiling (`limit` is clamped into it). */
export const DEFAULT_MAX_PAGE_SIZE = 200

/** Realtime: burst-coalescing window before a custom watched query recomputes. */
export const WATCH_DEBOUNCE_MS = 10

/** The fixed watch id SSE frames carry — one subscription per SSE request, no multiplexing. */
export const SSE_WATCH_ID = 'sse'
