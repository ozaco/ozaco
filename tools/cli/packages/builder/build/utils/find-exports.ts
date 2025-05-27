import { parse } from 'acorn-loose'

export const findExports = async (filePath: string) => {
  const code = await Bun.file(filePath).text()

  const parsed = parse(code, {
    ecmaVersion: 'latest',
    sourceType: 'module',
  })

  const exports: string[] = []

  for (const statement of parsed.body) {
    if (statement.type === 'ExportAllDeclaration') {
      exports.push(statement.source.value as string)
    }
  }

  return exports
}
