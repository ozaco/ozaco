import { exampleCore } from './core'

import { greetingAction } from './actions/greeting'
import { otherAction } from './actions/other'

const examplePlugin = exampleCore.register(greetingAction).register(otherAction)

const example = await examplePlugin()

// biome-ignore lint/suspicious/noConsole: <explanation>
console.log(example.greeting.hello('giveerr'))
// biome-ignore lint/suspicious/noConsole: <explanation>
console.log(example.other.other('giveerr'))
