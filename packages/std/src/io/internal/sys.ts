import { operation } from 'std:effect'

import { networkInterfaces, tmpdir } from 'node:os'

import type { NetworkInterface } from '../types/common'

// The OS temp directory (`node:os.tmpdir()`). Shared by the Bun and Node impls — node:os works under
// both. Used for ephemeral spills (e.g. the gateway streaming file uploads to a temp file).
export const readTmpDir = operation(function* () {
  return tmpdir()
})

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
