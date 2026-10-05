import type { IODef } from '../../types/io'

/**
 * Endpoint notation shared by the network actions (zmq's: `tcp://host:port`, `ipc://path`,
 * `inproc://name`). Pure string work, so every IO impl offers it — WebIO too.
 */
export const netEndpoint = {
  *parseEndpoint(endpoint: string): Generator<never, IODef.Endpoint | null> {
    const at = endpoint.indexOf('://')

    if (at === -1) {
      return null
    }

    const scheme = endpoint.slice(0, at)
    const rest = endpoint.slice(at + 3)

    if (rest.length === 0) {
      return null
    }

    switch (scheme) {
      case 'tcp': {
        const colon = rest.lastIndexOf(':')
        const port = colon === -1 ? Number.NaN : Number(rest.slice(colon + 1))

        if (!Number.isInteger(port) || port < 0 || port > 65_535) {
          return null
        }

        const host = rest.slice(0, colon)

        return { scheme, host: host === '*' || host === '' ? '0.0.0.0' : host, port }
      }
      case 'ipc': {
        return { scheme, path: rest }
      }
      case 'inproc': {
        return { scheme, name: rest }
      }
      default: {
        return null
      }
    }
  },
  *formatEndpoint(endpoint: IODef.Endpoint): Generator<never, string> {
    switch (endpoint.scheme) {
      case 'tcp': {
        return `tcp://${endpoint.host}:${endpoint.port}`
      }
      case 'ipc': {
        return `ipc://${endpoint.path}`
      }
      case 'inproc': {
        return `inproc://${endpoint.name}`
      }
      default: {
        return ''
      }
    }
  },
}
