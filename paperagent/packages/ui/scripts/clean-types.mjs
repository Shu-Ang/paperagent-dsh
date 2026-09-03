import { rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

// TypeScript does not remove declarations for deleted source modules. Keep this
// generated directory exact so renamed client modules cannot leave stale APIs.
// Windows may retain a short-lived handle while an editor, Defender, or a
// previous TypeScript invocation has just inspected generated declarations.
// A small bounded retry makes normal local builds reliable without masking a
// persistent lock.
const target = fileURLToPath(new URL('../lib/types', import.meta.url))
const attempts = 5
for (let attempt = 1; attempt <= attempts; attempt += 1) {
  try {
    await rm(target, { recursive: true, force: true, maxRetries: 0 })
    break
  } catch (error) {
    const code = error && typeof error === 'object' ? error.code : undefined
    if ((code !== 'EPERM' && code !== 'EBUSY') || attempt === attempts) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(`Cannot clean generated types at ${target}. Close any editor, file preview, or process using packages/ui/lib, then retry. (${detail})`, { cause: error })
    }
    await new Promise(resolve => setTimeout(resolve, attempt * 250))
  }
}
