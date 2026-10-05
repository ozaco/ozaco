/** ZMTP 3.1 (rfc.zeromq.org/spec/37) — the wire every zmq peer speaks. */
export const ZMTP_MAJOR = 3
export const ZMTP_MINOR = 1
export const GREETING_BYTES = 64
/** The mechanism we speak: no authentication, no encryption. */
export const MECHANISM = 'NULL'

/** Frame flag bits. */
export const FLAG_MORE = 0x01
export const FLAG_LONG = 0x02
export const FLAG_COMMAND = 0x04

/** The hub protocol's commands (frame 0 of every message between a peer and its hub). */
export enum CMD {
  /** `PUB id topic headers data` → `OK id count` */
  pub = 'PUB',
  /** `SUB id sid pattern group durable` → `OK id` */
  sub = 'SUB',
  /** `UNSUB sid` */
  unsub = 'UNSUB',
  /** `ACK sid seq` */
  ack = 'ACK',
  /** `NAK sid seq` */
  nak = 'NAK',
  /** `BYE` */
  bye = 'BYE',
  /** hub → peer: `MSG sid topic seq headers data` */
  msg = 'MSG',
  /** hub → peer: `OK id …` */
  ok = 'OK',
  /** hub → peer: `ERR id tag message` */
  err = 'ERR',
}

/** The application prefix the hub's in-process link runs under (every peer subject lives below
 * it, its own application prefix included). */
export const HUB_PREFIX = 'zmq'

export const HANDSHAKE_TIMEOUT_MS = 5000
export const DEFAULT_CONNECT_TIMEOUT_MS = 5000
/** How long a call made while the hub is down waits for it before failing. */
export const DEFAULT_OFFLINE_TIMEOUT_MS = 5000
/** ZMTP `PING` cadence and the silence that ends a connection (libzmq: `ZMQ_HEARTBEAT_IVL` /
 * `ZMQ_HEARTBEAT_TIMEOUT`). */
export const DEFAULT_HEARTBEAT_MS = 5000
export const DEFAULT_HEARTBEAT_TIMEOUT_MS = 15_000
/** Redial backoff: first pause, then doubling up to the cap (libzmq: 100 ms → 30 s). */
export const REDIAL_MIN_MS = 100
export const REDIAL_MAX_MS = 5000
/** The `Socket-Type`s a ROUTER accepts (rfc 37 §Socket-Type compatibility). */
export const ROUTER_PEERS = new Set(['REQ', 'DEALER', 'ROUTER'])
/** The `Socket-Type`s a DEALER accepts. */
export const DEALER_PEERS = new Set(['REP', 'DEALER', 'ROUTER'])

export const INPROC_HUBS = Symbol.for('transport:zmq.inproc')
