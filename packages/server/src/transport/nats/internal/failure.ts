import type { Result } from 'std:result'

import { JetStreamApiCodes, JetStreamApiError } from '@nats-io/jetstream'

/** Renders an attempt-captured failure into breadcrumb strings (native errors included). */
export const causesOf = (failure: Result.Failure<unknown>): string[] => [
  failure.message || String(failure.error),
  ...failure.causes.map(String),
]

/** `consumers.info` on a durable nobody created — the definitive "not hosted" answer. */
export const isConsumerNotFound = (failure: Result.Failure<unknown>): boolean =>
  failure.error instanceof JetStreamApiError &&
  failure.error.code === JetStreamApiCodes.ConsumerNotFound
