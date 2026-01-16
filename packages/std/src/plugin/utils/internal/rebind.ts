import type { Impl } from '../../types'

export const createRebind: Impl.CreateRebind = ({ event, rebindings }) => {
  return (key, handler) => {
    if (rebindings.has(key)) {
      return
    }

    event.on('use', handler)
    rebindings.add(key)
  }
}
