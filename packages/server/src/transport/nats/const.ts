/**
 * The wire is JetStream, not core NATS.
 *
 * Core NATS has no replay: a subscriber that attaches after a publish has simply missed it. Every
 * lane defect this transport has had traces back to that one fact — an answer's opening chunks lost
 * because the reader subscribed a tick late, a queued event dropped because nobody happened to be
 * listening yet. A JetStream stream keeps its messages, so a consumer reads what was published
 * rather than what it was in time for.
 */
export const WIRE = 'v1'

export const DEFAULT_PREFIX = 'ozaco'
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

/** The three streams, named off the subject prefix so two apps can share one server. */
export const streamNames = (prefix: string) => ({
  rpc: `${prefix.toUpperCase()}_RPC`,
  lane: `${prefix.toUpperCase()}_LANE`,
  event: `${prefix.toUpperCase()}_EVENT`,
})

/**
 * A dispatch is delivered AT MOST ONCE, and this is what enforces it.
 *
 * A work-queue stream otherwise redelivers anything left unacked past `ack_wait` — which is exactly
 * the failure the router exists to prevent: an owner that already ran the body, was slow to ack, and
 * has the same call handed to someone else. With `max_deliver: 1` an unacked message is terminal
 * instead. A lost call is an error the caller sees; a duplicated one is a silent second set of side
 * effects.
 */
export const RPC_MAX_DELIVER = 1

/** How long a message may sit in each stream. All three carry live traffic, never history. */
export const RPC_MAX_AGE_NS = 60_000_000_000 // 60s — longer than any sane request timeout

/**
 * A durable nobody has pulled for this long is retired by the SERVER (JetStream
 * `inactive_threshold`). A live replica keeps permanent interest through its pull loop, so this
 * never touches a bound consumer; what it retires is exactly the leftovers — durables from an older
 * naming scheme after a deploy, and addresses a release stopped serving — the two things that
 * otherwise block work-queue binds forever and answer `hosts()` for nobody. Matches the RPC
 * stream's own max_age: a consumer idle longer than any message could live holds nothing.
 */
export const RPC_INACTIVE_THRESHOLD_NS = 60_000_000_000 // 60s

/**
 * How an address blocked by a foreign durable heals. `ensureRpcConsumer` arms expiry
 * ({@link RPC_INACTIVE_THRESHOLD_NS}) on the blockers, and the watcher then claims the address in
 * the background at this tick — quiet, slow, forever: the one blocker that never goes idle (a live
 * foreign owner, i.e. two apps sharing a prefix) keeps the error visible at a low duty cycle.
 */
export const RECLAIM_INTERVAL_MS = 5000
export const RECLAIM_LOG_EVERY = 12 // one "still blocked" error per minute
export const LANE_MAX_AGE_NS = 300_000_000_000 // 5m — a download may legitimately take a while
export const EVENT_MAX_AGE_NS = 3_600_000_000_000 // 1h — enough for a consumer to restart

/** Markers on a lane subject. `end` and `error` are different messages, not one flag. */
export const LANE_EVENT = 'ozaco-lane-event'
export const LANE_END = 'end'
export const LANE_ERROR = 'error'

/**
 * The writer's keepalive. A lane whose owner was SIGKILLed after the `__stream__` reply has no one
 * left to publish its end marker — without a heartbeat the reader would wait forever. The writer
 * ticks while its pump lives; a reader that sees neither data nor ticks for {@link LANE_STALE_MS}
 * declares the writer lost. Ticks ride the lane like any marker, so a legitimately idle feed (an
 * SSE channel between events) stays visibly alive.
 */
export const LANE_TICK = 'tick'
export const LANE_TICK_MS = 15_000
export const LANE_STALE_MS = 45_000 // 3 missed ticks

/**
 * The reader's bound. Lane data is pulled in BATCHES and the next batch is requested only while
 * the local buffer sits under these marks — a slow consumer parks the reader instead of growing
 * its RAM. The stream is the buffer; the process is not.
 */
export const LANE_FETCH_MESSAGES = 64
export const LANE_FETCH_EXPIRES_MS = 5000
export const LANE_BUFFER_MAX_BYTES = 16_777_216 // 16 MiB retained locally, per lane
export const LANE_BUFFER_MAX_MESSAGES = 256

/**
 * The WRITER's bound — a credit window, so a transfer's in-flight tail cannot grow past what the
 * reader has sanctioned. The writer starts with one free window (a transfer smaller than it costs
 * ZERO credit traffic); the reader grants more as its consumer actually drains, in steps, as a
 * cumulative byte count. A reader that closes says `stop`; a window that never reopens within the
 * credit timeout is a gone reader, and the pump aborts instead of publishing into the void.
 */
export const LANE_WINDOW_BYTES = 33_554_432 // 32 MiB in flight before the first grant is needed
export const LANE_GRANT_STEP_BYTES = 8_388_608 // grant every 8 MiB drained
export const LANE_CREDIT_TIMEOUT_MS = 60_000

/** A reader whose OWN consumer stopped draining gives up after this long and closes the lane —
 * an abandoned download must not park a reader task and its buffer until process exit. */
export const LANE_ABANDON_MS = 300_000 // matches the LANE stream's own max_age

/** Set when a lane's payloads ARE the values — raw bytes that never reach the codec. */
export const LANE_ENCODING = 'ozaco-lane-enc'
export const LANE_BINARY = 'bin'

/**
 * Part framing on a `parts` lane — a multipart body crossing the wire.
 *
 * The parts arrive in wire order on ONE lane, because order is the multipart contract: a record of
 * lanes would imply every file is available at once. A `field` message carries the value in its
 * payload; a `file` message opens a file whose raw chunks follow until `file-end` closes it.
 */
export const LANE_PART = 'ozaco-lane-part'
export const LANE_PART_FIELD = 'field'
export const LANE_PART_FILE = 'file'
export const LANE_PART_FILE_END = 'file-end'

/** Carried on a dispatch so the owner knows where to answer and which lane belongs to it. */
export const HDR_REPLY = 'ozaco-reply'
export const HDR_CID = 'ozaco-cid'

/** The group a node joins for `queued` events when it names none. */
export const DEFAULT_GROUP = 'default'

export const EMPTY_PAYLOAD: Uint8Array = new Uint8Array(0)
