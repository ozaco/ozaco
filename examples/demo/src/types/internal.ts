/** Private shapes of the demo's internals — not exported by the barrel. */
import type { Schema } from 'db:core'
import type { EdgeDef } from 'server:core'
import type { Queue, Task } from 'std:effect'

import type { z } from 'zod'

import type { Report } from '../internal/services/rtc'
import type { todosTable } from '../utils/tables'

export type Todo = Schema.Infer<typeof todosTable>

// --- rtc relay (internal/services/rtc.ts) ----------------------------------------------------

export interface Member {
  readonly id: string

  /** the role of the CURRENT pairing (undefined until one forms). */
  polite?: boolean

  /** present only on the node that holds the socket — that node does the sending. */
  readonly socket?: EdgeDef.Socket
}

export interface Room {
  /** member id → member, at most two, LOCAL and remote alike. */
  members: Map<string, Member>

  /** Bumped on every pairing — the session id both members run and stamp their frames with. */
  epoch: number
}

/** One pairing, derived from the pair alone so every node computes the same thing. */
export interface Pairing {
  epoch: number

  /** member id → polite. */
  roles: Record<string, boolean>
}

export type RelayEvent =
  | { t: 'join'; node: string; room: string; member: string }
  | { t: 'leave'; node: string; room: string; member: string }
  | { t: 'pair'; node: string; room: string; pairing: Pairing }
  | { t: 'frame'; node: string; room: string; from: string; frame: unknown }

export type ReportInput = z.infer<typeof Report>

// --- the browser call page (internal/rtc-page.ts) --------------------------------------------

/** A frame the RELAY sends about the session itself; everything else is signaling. */
export interface Control {
  t?: string
  polite?: boolean
  epoch?: number
}

/** The live peer session for ONE pairing epoch. */
export interface Session {
  epoch: number

  /** signaling frames of this epoch, fed by the control loop into the peer's signal */
  inbound: Queue<unknown, void>
  task: Task<unknown>
}
