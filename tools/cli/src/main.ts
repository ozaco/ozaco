import { friendlyErrorPlugin, helpPlugin, notFoundPlugin, versionPlugin } from 'clerc'

import { cli } from '.'
import { plugin as builder } from '../packages/builder'

cli
  .use(helpPlugin())
  .use(notFoundPlugin())
  .use(versionPlugin())
  .use(friendlyErrorPlugin())
  .use(builder)
  .parse()
