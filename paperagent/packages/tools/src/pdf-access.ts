/** Narrow, expiring browser access to one locally managed original PDF. */

import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { PaperAgentStore } from '@paperagent/domain'
import { paperArtifactPaths } from '@paperagent/domain'

interface PdfGrant {
  readonly workspacePath: string
  readonly paperId: string
  readonly expiresAt: number
}

const GRANT_TTL_MS = 10 * 60_000
const MAX_RANGE_BYTES = 32 * 1024 * 1024

/**
 * The Remote BFF creates opaque capabilities after resolving the caller's
 * active session. The HTTP route accepts only those short-lived capabilities,
 * never a browser-supplied filesystem path or workspace path.
 */
export class PaperPdfAccess {
  #grants = new Map<string, PdfGrant>()

  async create(store: PaperAgentStore, workspacePath: string, paperId: string): Promise<{ readonly url: string; readonly expiresAt: number }> {
    const paper = store.getPaper(workspacePath, paperId)
    const source = paperArtifactPaths(paper).pdf
    const info = await stat(source).catch(() => undefined)
    if (info === undefined || !info.isFile() || info.size === 0) throw new Error('the original PDF is not available for this paper')
    this.removeExpired()
    const token = randomUUID().replaceAll('-', '')
    const expiresAt = Date.now() + GRANT_TTL_MS
    this.#grants.set(token, { workspacePath, paperId, expiresAt })
    return { url: `/api/paperagent/pdf/${token}`, expiresAt }
  }

  /** Node HTTP handler registered under `/api/paperagent/pdf`. */
  async handle(store: PaperAgentStore, req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Preview requests can outlive the last grant creation. Prune the small
    // in-memory capability table on every request so expired tokens do not
    // accumulate indefinitely in a long-running local DSH process.
    this.removeExpired()
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' })
      res.end()
      return
    }
    const token = new URL(req.url ?? '/', 'http://localhost').pathname.split('/').at(-1)
    if (token === undefined || !/^[a-f0-9]{32}$/i.test(token)) return this.notFound(res)
    const grant = this.#grants.get(token)
    if (grant === undefined || grant.expiresAt <= Date.now()) {
      this.#grants.delete(token)
      return this.notFound(res)
    }
    let source: string
    try {
      source = paperArtifactPaths(store.getPaper(grant.workspacePath, grant.paperId)).pdf
    } catch {
      return this.notFound(res)
    }
    const info = await stat(source).catch(() => undefined)
    if (info === undefined || !info.isFile()) return this.notFound(res)
    const range = parseRange(req.headers.range, info.size)
    if (range === 'invalid') {
      res.writeHead(416, { 'Content-Range': `bytes */${info.size}` })
      res.end()
      return
    }
    const start = range?.start ?? 0
    const end = range?.end ?? info.size - 1
    const length = end - start + 1
    const headers = {
      'Content-Type': 'application/pdf',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, no-store',
      'Content-Length': String(length),
      ...(range === undefined ? {} : { 'Content-Range': `bytes ${start}-${end}/${info.size}` }),
    }
    res.writeHead(range === undefined ? 200 : 206, headers)
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    const stream = createReadStream(source, { start, end })
    stream.once('error', () => { if (!res.headersSent) this.notFound(res); else res.destroy() })
    stream.pipe(res)
  }

  private notFound(res: ServerResponse): void {
    res.writeHead(404, { 'Cache-Control': 'no-store' })
    res.end()
  }

  private removeExpired(): void {
    const now = Date.now()
    for (const [token, grant] of this.#grants) if (grant.expiresAt <= now) this.#grants.delete(token)
  }
}

function parseRange(header: string | undefined, size: number): { readonly start: number; readonly end: number } | 'invalid' | undefined {
  if (header === undefined || header.trim() === '') return undefined
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (match === null || size <= 0) return 'invalid'
  const rawStart = match[1]
  const rawEnd = match[2]
  if (rawStart === '' && rawEnd === '') return 'invalid'
  let start: number
  let end: number
  if (rawStart === '') {
    const suffix = Number(rawEnd)
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return 'invalid'
    start = Math.max(0, size - Math.min(suffix, MAX_RANGE_BYTES))
    end = size - 1
  } else {
    start = Number(rawStart)
    if (!Number.isSafeInteger(start) || start < 0 || start >= size) return 'invalid'
    const requestedEnd = rawEnd === '' ? size - 1 : Number(rawEnd)
    if (!Number.isSafeInteger(requestedEnd) || requestedEnd < start) return 'invalid'
    end = Math.min(requestedEnd, start + MAX_RANGE_BYTES - 1, size - 1)
  }
  return { start, end }
}
