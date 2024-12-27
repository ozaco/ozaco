import { cli } from './shared/cli'

import { builderPlugin } from './plugins/builder/plugin'

cli.use(builderPlugin).parse()
