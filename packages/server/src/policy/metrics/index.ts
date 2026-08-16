/**
 * `server:policy/metrics` — the observer policy feeding the metrics collector. Records every
 * dispatch (success AND failure) with the full correlation spine (requestId / serviceId / laneId /
 * actionId + outcome/delivered) through a sync, isolated sink planted by `server:metrics`.
 */
export * from './definition'
export type * from './types'
