export const readJsonFile = async (filePath: string) => {
  const file = Bun.file(filePath)

  if (!(await file.exists())) {
    throw new Error(`${filePath} not found`)
  }

  return await file.json()
}
