import { readFile, readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'lib') continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await sourceFiles(path))
    else if (/\.(?:ts|tsx|mts|cts)$/.test(entry.name)) files.push(path)
  }
  return files
}

const violations = []
for (const path of await sourceFiles(join(root, 'packages/domain/src'))) {
  const text = await readFile(path, 'utf8')
  if (/from\s+['"](?:@deepseek-ai\/dsh|@paperagent\/dsh|[^'"]*ui-|react)['"]/.test(text)) {
    violations.push(`${relative(root, path)} imports a UI/DSH runtime`)
  }
  if (/\bfetch\s*\(/.test(text)) violations.push(`${relative(root, path)} performs network I/O`) 
}

const parserPackage = JSON.parse(await readFile(join(root, 'packages/parser-mineru/package.json'), 'utf8'))
const parserDeps = Object.keys(parserPackage.dependencies ?? {})
if (parserDeps.some(name => !['@paperagent/domain'].includes(name))) {
  violations.push(`packages/parser-mineru/package.json has unexpected dependencies: ${parserDeps.join(', ')}`)
}

if (violations.length > 0) {
  console.error('Architecture check failed:')
  for (const violation of violations) console.error(`- ${violation}`)
  process.exitCode = 1
} else {
  console.log('Architecture check passed: domain has no UI/DSH/network dependency; parser dependency direction is valid.')
}
