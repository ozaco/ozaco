import { operation } from 'std:effect'

import { networkInterfaces } from 'node:os'

import type { NetworkInterface } from '../types/common'

// Flatten node:os.networkInterfaces() (a name -> addresses map) into a single list, tagging each
// address with its interface name. Shared by the Bun and Node impls — node:os works under both.
export const readInterfaces = operation(function* () {
  const result: NetworkInterface[] = []

  for (const [name, infos] of Object.entries(networkInterfaces())) {
    if (infos === undefined) {
      continue
    }
    for (const info of infos) {
      result.push({
        name,
        address: info.address,
        family: info.family as 'IPv4' | 'IPv6',
        internal: info.internal,
        mac: info.mac,
        netmask: info.netmask,
        cidr: info.cidr ?? null,
      })
    }
  }

  return result
})
