import { Prompt, Spinner } from 'cli:core'
import { DefaultPalette } from 'cli:palette'
import { DefaultPrompt } from 'cli:prompt'
import { DefaultSpinner } from 'cli:spinner'
import { attempt, main, sleep } from 'std:effect'
import { DefaultLogger, Logger } from 'std:logger'
import { install } from 'std:plugin'
import { isFailure } from 'std:result'

import { BunTerminal } from 'cli:terminal/bun'
import { BunIO } from 'std:io/impl/bun'
import { ConsoleTransport } from 'std:logger/transport/console'

await main(function* () {
  yield* install(BunIO)
  yield* install(DefaultLogger)
  yield* install(ConsoleTransport)

  yield* install(BunTerminal)
  yield* install(DefaultPalette)
  yield* install(DefaultSpinner)
  yield* install(DefaultPrompt)

  yield* Logger.actions.info('ozaco · interactive cli demo')

  const answers = yield* attempt(function* () {
    const name = yield* Prompt.actions.text({
      message: 'Project name',
      description: 'Used for package.json and the project folder.',
      initial: 'my-app',
      placeholder: 'kebab-case-name',
      validate: value =>
        /^[a-z][a-z0-9-]*$/u.test(value) ? undefined : 'lowercase letters, digits and dashes only',
    })

    const template = yield* Prompt.actions.select({
      message: 'Template',
      description: 'Determines the bundler and framework scaffolding.',
      initial: 'react',
      choices: [
        { value: 'react', label: 'React', hint: 'vite + react' },
        { value: 'vue', label: 'Vue', hint: 'vite + vue' },
        { value: 'svelte', label: 'Svelte', hint: 'sveltekit' },
        { value: 'solid', label: 'Solid', hint: 'coming soon', disabled: true },
      ],
    })

    const features = yield* Prompt.actions.multiselect({
      message: 'Features',
      description: 'Toggle with space, confirm with enter.',
      required: true,
      initial: ['eslint'],
      choices: [
        { value: 'eslint', label: 'ESLint', hint: 'linting' },
        { value: 'prettier', label: 'Prettier', hint: 'formatting' },
        { value: 'vitest', label: 'Vitest', hint: 'testing' },
        { value: 'tailwind', label: 'Tailwind', hint: 'styling' },
      ],
    })

    const typescript = yield* Prompt.actions.confirm({
      message: 'Use TypeScript?',
      description: 'Adds tsconfig and type-checking.',
      initial: true,
    })

    const port = yield* Prompt.actions.number({
      message: 'Dev server port',
      description: 'Port the dev server listens on (1024–65535).',
      initial: 3000,
      min: 1024,
      max: 65_535,
    })

    const license = yield* Prompt.actions.autocomplete({
      message: 'License',
      description: 'Type to filter the SPDX list.',
      placeholder: 'type to filter…',
      choices: [
        { value: 'MIT' },
        { value: 'Apache-2.0' },
        { value: 'BSD-3-Clause' },
        { value: 'GPL-3.0' },
        { value: 'Unlicense' },
      ],
    })

    const token = yield* Prompt.actions.password({
      message: 'Registry token',
      description: 'Optional; kept only for this session.',
      validate: value =>
        value.length === 0 || value.length >= 8 ? undefined : 'at least 8 characters',
    })

    const directory = yield* Prompt.actions.path({
      message: 'Output directory',
      description: 'Where the project will be created (Tab to complete).',
      initial: './',
      directory: true,
    })

    return { name, template, features, typescript, port, license, token, directory }
  })

  if (isFailure(answers)) {
    yield* Logger.actions.warn('scaffolding aborted', answers)
    return
  }

  const project = answers.value

  const scaffold = yield* Spinner.actions.group()

  const deps = yield* scaffold.task('Installing dependencies')
  const resolve = yield* deps.task('Resolving')
  yield* sleep(400)
  yield* resolve.succeed('Resolved 142 packages')

  const download = yield* deps.bar('Downloading', { total: 100 })
  for (let percent = 0; percent <= 100; percent += 20) {
    yield* download.update(percent)
    yield* sleep(150)
  }
  yield* download.succeed()
  yield* deps.succeed('Dependencies installed')

  const link = yield* scaffold.task('Linking workspace')
  yield* sleep(300)
  yield* link.succeed()

  yield* scaffold.stop()

  yield* Logger.actions.info(`${project.name} ready`, {
    template: project.template,
    features: project.features,
    license: project.license,
    port: project.port,
    output: project.directory,
    typescript: project.typescript,
    authenticated: project.token.length > 0,
  })
})
