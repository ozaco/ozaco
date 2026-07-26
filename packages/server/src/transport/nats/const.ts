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
export const LANE_MAX_AGE_NS = 300_000_000_000 // 5m — a download may legitimately take a while
export const EVENT_MAX_AGE_NS = 3_600_000_000_000 // 1h — enough for a consumer to restart

/** Markers on a lane subject. `end` and `error` are different messages, not one flag. */
export const LANE_EVENT = 'ozaco-lane-event'
export const LANE_END = 'end'
export const LANE_ERROR = 'error'

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
