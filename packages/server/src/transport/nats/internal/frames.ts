// oxlint-disable import/exports-last
import type { Wire } from 'server:core'

import { headers } from '@nats-io/nats-core'
import type { MsgHdrs } from '@nats-io/nats-core'

/**
 * LANE FRAMING DECISION: `lane` envelopes are NOT moved through the codec on this carrier — the
 * JSON baseline mangles `Uint8Array` payloads (`{"0":255,…}`). Instead every lane message frames
 * itself natively: the chunk travels as the RAW NATS payload (raw bytes for byte lanes, the
 * codec-encoded value for value lanes) and the tiny structural part (`kind`/`seq`/terminal error)
 * rides in NATS headers. Error frames carry the `Wire.Failure` as a UTF-8 JSON payload — full
 * tag/message/causes fidelity without header charset concerns.
 */

const KIND_HEADER = 'Oz-Lane-Kind'
const SEQ_HEADER = 'Oz-Lane-Seq'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export type LaneFrame =
  | { readonly kind: 'data'; readonly seq: number; readonly data: Uint8Array }
  /** A RAW multipart file chunk on an input lane — the `p: 'chunk'` Wire.PartFrame, payload as-is. */
  | { readonly kind: 'chunk'; readonly seq: number; readonly data: Uint8Array }
  | { readonly kind: 'end'; readonly seq: number }
  | { readonly kind: 'error'; readonly seq: number; readonly failure: Wire.Failure }

export interface EncodedLaneFrame {
  readonly payload: Uint8Array
  readonly headers: MsgHdrs
}

export const encodeLaneFrame = (frame: LaneFrame): EncodedLaneFrame => {
  const hdrs = headers()

  hdrs.set(KIND_HEADER, frame.kind)
  hdrs.set(SEQ_HEADER, String(frame.seq))

  const payload =
    frame.kind === 'data' || frame.kind === 'chunk'
      ? frame.data
      : frame.kind === 'error'
        ? encoder.encode(JSON.stringify(frame.failure))
        : new Uint8Array(0)

  return { payload, headers: hdrs }
}

const isWireFailure = (value: unknown): value is Wire.Failure =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as Wire.Failure).error === 'string' &&
  typeof (value as Wire.Failure).message === 'string' &&
  Array.isArray((value as Wire.Failure).causes)

/** Parses a lane message back into a frame; `undefined` marks an unframed/foreign message. */
export const parseLaneFrame = (msg: {
  readonly data: Uint8Array
  readonly headers?: MsgHdrs | undefined
}): LaneFrame | undefined => {
  const kind = msg.headers?.get(KIND_HEADER)
  const seq = Number(msg.headers?.get(SEQ_HEADER) || '0')

  if (kind === 'data' || kind === 'chunk') {
    return { kind, seq, data: msg.data }
  }

  if (kind === 'end') {
    return { kind, seq }
  }

  if (kind === 'error') {
    let failure: unknown

    try {
      failure = JSON.parse(decoder.decode(msg.data))
    } catch {
      failure = undefined
    }

    return {
      kind,
      seq,
      failure: isWireFailure(failure)
        ? failure
        : {
            error: 'server:transport/nats.wire',
            message: 'the lane closed with an undecodable error frame',
            causes: [],
          },
    }
  }

  return undefined
}
