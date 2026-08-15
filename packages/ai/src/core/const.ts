/** Tool-loop round budget when `maxRounds` is not given. */
export const DEFAULT_MAX_ROUNDS = 4

/** Base delay of the rate-limit retry backoff (doubles per attempt) when the failure carries no
 * retry-after hint. */
export const RETRY_BASE_DELAY_MS = 250

/** Cause prefix carrying the provider's retry-after hint on `ai.rate-limit` failures — providers
 * attach `retry-after:<seconds>` and the client's retry honors it. */
export const RETRY_AFTER_CAUSE = 'retry-after'
