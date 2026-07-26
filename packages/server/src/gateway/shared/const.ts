import { createContext } from 'std:effect'

export const JSON_CONTENT = 'application/json'
export const RAW_BINARY = 'application/octet-stream'
export const FORM_DATA = 'multipart/form-data'
export const FORM_URLENCODED = 'application/x-www-form-urlencoded'

export const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH'])

/**
 * The live connection an exchange is running on, when there is one.
 *
 * Replaces the general-purpose "raw request" escape hatch. That hatch handed the platform's own
 * object to anything that asked, so its one real consumer — looking up which socket is speaking —
 * was indistinguishable from an action reaching around the whole abstraction. Named for what it is
 * and owned by the gateway, it cannot be mistaken for a supported way into the platform.
 */
export const ConnectionContext = createContext<unknown>('server:gateway:connection')
