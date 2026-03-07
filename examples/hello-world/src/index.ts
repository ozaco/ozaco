import { fail, isSuccess, map, orElse, pipe, succeed, unwrap } from '@ozaco/std/result'

const greet = (name: string) => {
  if (!name.trim()) return fail('empty_name', 'Name cannot be empty')
  return succeed(`Hello, ${name}!`)
}

const result = pipe(
  greet('World'),
  map(msg => msg.toUpperCase()),
)

if (isSuccess(result)) {
  console.log(unwrap(result))
}

const recovered = pipe(
  greet(''),
  orElse(() => succeed('Hello, stranger!')),
)

console.log(unwrap(recovered))
