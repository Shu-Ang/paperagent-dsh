import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { clientBundle } from '../../../deepseek-harness/packages/client/tsdown.client.ts'

const require = createRequire(import.meta.url)
const workerPath = require.resolve('pdfjs-dist/legacy/build/pdf.worker.min.mjs')
const base = clientBundle('@paperagent/dsh-paperagent-ui', ['lib/types/index.js'])

/** Inline the worker because DSH client plugins are served as one closure file. */
const pdfWorkerRaw = {
  name: 'paperagent-pdfjs-worker-raw',
  resolveId(source: string) {
    return source === 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?raw' ? '\0paperagent-pdfjs-worker-raw' : null
  },
  async load(id: string) {
    return id === '\0paperagent-pdfjs-worker-raw'
      ? `export default ${JSON.stringify(await readFile(workerPath, 'utf8'))}`
      : null
  },
}

export default (inline: { env?: Record<string, string | undefined> }) => {
  const configs = base(inline)
  return configs.map(config => config.name === '@paperagent/dsh-paperagent-ui/client'
    ? { ...config, plugins: [...(config.plugins ?? []), pdfWorkerRaw] }
    : config)
}
