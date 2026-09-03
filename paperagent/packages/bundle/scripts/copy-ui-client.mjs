/** Copy the browser artifact into the distributable DSH bundle. */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const uiLib = resolve(import.meta.dirname, '../../ui/lib')
const bundleLib = resolve(import.meta.dirname, '../lib')
await mkdir(bundleLib, { recursive: true })
const sourceId = '@paperagent/dsh-paperagent-ui'
const bundleId = '@paperagent/dsh-paperagent'
const client = await readFile(resolve(uiLib, 'client.js'), 'utf8')
if (!client.includes(sourceId)) throw new Error(`UI client did not register ${sourceId}`)
await writeFile(resolve(bundleLib, 'client.js'), client.replaceAll(sourceId, bundleId), 'utf8')
await writeFile(resolve(bundleLib, 'client.js.map'), await readFile(resolve(uiLib, 'client.js.map')))
