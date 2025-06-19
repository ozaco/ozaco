import { friendlyErrorPlugin, helpPlugin, notFoundPlugin, versionPlugin } from 'clerc'
import { plugin as builder } from '../packages/builder'
import { cli } from '.'

cli.use(helpPlugin()).use(notFoundPlugin()).use(versionPlugin()).use(friendlyErrorPlugin()).use(builder).parse()
