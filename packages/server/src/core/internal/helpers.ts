import type { Service } from '../types/service'

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
