import { homedir, networkInterfaces, tmpdir } from 'node:os'

import type { IODef } from '../../types/io'

// The OS temp directory (`node:os.tmpdir()`). Shared by the Bun and Node impls — node:os works under
// both. Used for ephemeral spills (e.g. the gateway streaming file uploads to a temp file).
export function* readTmpDir() {
  return tmpdir()
}

// The process's working directory and the user's home — `process.cwd()` / `node:os.homedir()`,
// both available under Bun and Node.
export function* readCwd() {
  return process.cwd()
}

export function* readHomeDir() {
  return homedir()
}

// Flatten node:os.networkInterfaces() (a name -> addresses map) into a single list, tagging each
// address with its interface name. Shared by the Bun and Node impls — node:os works under both.
export function* readInterfaces() {
  const result: IODef.NetworkInterface[] = []

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
}
