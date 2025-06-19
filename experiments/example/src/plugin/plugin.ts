import { greetingAction } from './actions/greeting'
import { otherAction } from './actions/other'
import { exampleCore } from './core'

const examplePlugin = exampleCore.register(greetingAction).register(otherAction)

const example = await examplePlugin()

// biome-ignore lint/suspicious/noConsole: Redundant
console.log(example.greeting.hello('giveerr'))
// biome-ignore lint/suspicious/noConsole: Redundant
console.log(example.other.other('giveerr'))
