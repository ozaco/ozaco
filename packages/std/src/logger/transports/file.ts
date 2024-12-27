import { loggerTags } from '../tag'
import { createTransport } from '../utils/transport'

export const createFileTransport = () => {
  return createTransport(message => {
    console.log(message)
  }, loggerTags.get('file-transport'))
}
