import type { Result } from 'std:result'
import type { AnyType } from 'std:shared'

import type { Service } from '../types/service'

const NOISE_TAG_NAMES = new Set([
  'server/broker',
  'server/transport',
  'server/tracer',
  'server/codec',
  'logger',
])

const isNoiseTag = (tag: string): boolean => {
  const at = tag.indexOf('@')
  const name = at === -1 ? tag : tag.slice(0, at)
  return NOISE_TAG_NAMES.has(name)
}

export const findServiceId = (
  services: Map<string, Service>,
  service: Service,
): string | undefined => {
  for (const [id, svc] of services) {
    if (svc === service) {
      return id
    }
  }
  return undefined
}

export const resolveGroups = (
  services: Map<string, Service>,
  groups: ReadonlyArray<string | Service> | undefined,
): ReadonlyArray<string> | undefined => {
  if (!groups || groups.length === 0) {
    return undefined
  }
  const out: string[] = []
  for (const group of groups) {
    if (typeof group === 'string') {
      out.push(group)
      continue
    }
    const id = findServiceId(services, group)
    if (id) {
      out.push(id)
    }
  }
  return out
}

export const resolveService = (
  services: Map<string, Service>,
  serviceName: string,
): { service: Service; registeredName: string } | undefined => {
  const exact = services.get(serviceName)
  if (exact) {
    return { service: exact, registeredName: serviceName }
  }
  for (const [name, svc] of services) {
    if (svc.name === serviceName) {
      return { service: svc, registeredName: name }
    }
  }
  return undefined
}

export const principalDiscriminator = (rawReq: unknown): string => {
  if (rawReq && typeof rawReq === 'object' && 'meta' in rawReq) {
    const meta = (rawReq as { meta?: Record<string, string> }).meta
    if (meta && typeof meta === 'object') {
      return `${meta.authorization ?? ''}\u0000${meta.cookie ?? ''}`
    }
  }
  return ''
}

export const simplifyFailureCauses = <E>(failure: Result.Failure<E>): Result.Failure<E> => {
  const causes = failure.causes
  const drop = new Set<number>()

  for (let i = 0; i < causes.length; i++) {
    if (!isNoiseTag(causes[i]!)) {
      continue
    }
    drop.add(i)
    if (i > 0) {
      drop.add(i - 1)
    }
  }

  if (drop.size === 0) {
    return failure
  }

  const out = causes.filter((_, i) => !drop.has(i))

  ;(failure as AnyType).causes = out

  return failure
}
