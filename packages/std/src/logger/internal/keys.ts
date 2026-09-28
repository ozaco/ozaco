import { RESERVED_KEYS } from './const'

/** A key the way the backends compare it: lowercase, every non-alphanumeric character `_`. */
export const backendKey = (key: string): string => key.toLowerCase().replaceAll(/[^a-z0-9]/gu, '_')

/**
 * Whether a log attribute key collides with a field the log backends reserve (`trace_id`,
 * `span_id`, `flags`, `severity*`, `detected_level`, `level`, `*timestamp`, `body`, `scope_*`,
 * `event_name`, `o2_event_name`, `instrumentation_library_*`, `dropped_attributes_count`,
 * `service_name`), compared after {@link backendKey} normalization (`Trace-Id`, `service.name`).
 */
export const isReservedLogKey = (key: string): boolean => RESERVED_KEYS.has(backendKey(key))
