export const dispatchSubject = (prefix: string, serviceName: string, actionKey: string) =>
  `${prefix}.dispatch.${serviceName}.${actionKey}`

export const dispatchServicePrefix = (prefix: string, serviceName: string) =>
  `${prefix}.dispatch.${serviceName}.`

export const emitSubject = (prefix: string, name: string) => `${prefix}.event.emit.${name}`

export const emitGroupSubject = (prefix: string, group: string, name: string) =>
  `${prefix}.event.emit.${group}.${name}`

export const broadcastSubject = (prefix: string, name: string) =>
  `${prefix}.event.broadcast.${name}`

export const emitWildcard = (prefix: string) => `${prefix}.event.emit.>`

export const broadcastWildcard = (prefix: string) => `${prefix}.event.broadcast.>`
