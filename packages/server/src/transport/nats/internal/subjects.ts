export const dispatchSubject = (prefix: string, serviceName: string, actionKey: string) =>
  `${prefix}.dispatch.${serviceName}.${actionKey}`

export const dispatchServicePrefix = (prefix: string, serviceName: string) =>
  `${prefix}.dispatch.${serviceName}.`

export const emitSubject = (prefix: string, name: string) => `${prefix}.event.emit.${name}`

export const emitGroupSubject = (prefix: string, group: string, name: string) =>
  `${prefix}.event.emit.${group}.${name}`

export const emitWildcard = (prefix: string) => `${prefix}.event.emit.>`

export const broadcastSubject = (prefix: string, name: string) =>
  `${prefix}.event.broadcast.${name}`

export const broadcastWildcard = (prefix: string) => `${prefix}.event.broadcast.>`

export const streamInputSubject = (prefix: string, sid: string, index: number) =>
  `${prefix}.stream.${sid}.in.${index}`

export const streamOutputSubject = (prefix: string, sid: string) => `${prefix}.stream.${sid}.out`

export const cancelSubject = (prefix: string, cid: string) => `${prefix}.cancel.${cid}`
