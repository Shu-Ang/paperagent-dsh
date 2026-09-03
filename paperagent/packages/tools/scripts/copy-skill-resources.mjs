/** Copy co-located runtime Skill resources beside the bundled tools entry. */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const sourceRoot = resolve(import.meta.dirname, '../src')
const outputRoot = resolve(import.meta.dirname, '../lib')

for (const directory of ['import', 'research', 'writing']) {
  const destination = resolve(outputRoot, directory)
  await mkdir(destination, { recursive: true })
  await writeFile(resolve(destination, 'SKILL.md'), await readFile(resolve(sourceRoot, directory, 'SKILL.md'), 'utf8'), 'utf8')
}
