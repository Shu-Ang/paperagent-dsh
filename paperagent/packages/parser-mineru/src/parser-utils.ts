import { randomUUID } from 'node:crypto'
import { rename, unlink, writeFile } from 'node:fs/promises'

export function normalizeBaseUrl(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'https:') throw new Error('MinerU API base URL must use HTTPS')
  return url.toString().replace(/\/$/, '')
}

export function withSignal(init: RequestInit, signal: AbortSignal | undefined): RequestInit {
  return signal === undefined ? init : { ...init, signal }
}

export async function readJsonResponse(response: Response, operation: string): Promise<Record<string, unknown>> {
  let body: unknown
  try { body = await response.json() } catch { throw new Error(`${operation} returned invalid JSON`) }
  const recordBody = record(body)
  if (!response.ok) {
    const message = stringValue(recordBody.msg) ?? stringValue(recordBody.message) ?? 'no detail returned'
    const traceId = stringValue(recordBody.trace_id)
    throw new Error(`${operation} failed with HTTP ${response.status}: ${userSafeError(message)}${traceId === undefined ? '' : ` (MinerU trace_id: ${traceId})`}`)
  }
  if (numberValue(recordBody.code) !== 0) throw new Error(`${operation} failed: ${stringValue(recordBody.msg) ?? 'unknown MinerU error'}`)
  return recordBody
}

export function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

export function stringValue(value: unknown): string | undefined { return typeof value === 'string' && value !== '' ? value : undefined }
export function numberValue(value: unknown): number | undefined { return typeof value === 'number' && Number.isFinite(value) ? value : undefined }
export function normalizeText(value: string): string { return value.toLocaleLowerCase().replace(/[`*_>#\[\](){}]/g, ' ').replace(/\s+/g, ' ').trim() }
export function ensureTrailingNewline(value: string): string { return `${value.replace(/\s+$/, '')}\n` }
export function throwIfAborted(signal: AbortSignal | undefined): void { if (signal?.aborted === true) throw new Error('parsing cancelled') }

export function delay(milliseconds: number, signal: AbortSignal | undefined): Promise<void> {
  throwIfAborted(signal)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds)
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('parsing cancelled')) }, { once: true })
  })
}

export function userSafeError(error: unknown): string {
  if (error instanceof Error) return error.message.replace(/Bearer\s+[^\s]+/gi, 'Bearer [redacted]')
  return String(error)
}

/** Extract useful Node/undici causes such as ETIMEDOUT without surfacing request URLs. */
export function networkErrorMessage(error: unknown): string {
  const parts: string[] = []
  const seen = new Set<unknown>()
  let current: unknown = error
  while (typeof current === 'object' && current !== null && !seen.has(current)) {
    seen.add(current)
    const candidate = current as { message?: unknown; code?: unknown; cause?: unknown }
    if (typeof candidate.message === 'string' && candidate.message !== '' && !parts.includes(candidate.message)) parts.push(candidate.message)
    if (typeof candidate.code === 'string' && candidate.code !== '' && !parts.includes(candidate.code)) parts.push(candidate.code)
    current = candidate.cause
  }
  return userSafeError(parts.length === 0 ? String(error) : parts.join('; '))
}

export async function writeAtomically(path: string, content: string): Promise<void> {
  const temporaryPath = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporaryPath, content, 'utf8')
    await rename(temporaryPath, path)
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined)
    throw error
  }
}

export async function writeArtifactPair(markdownPath: string, markdown: string, sourceMapPath: string, sourceMap: string): Promise<void> {
  await writeAtomically(markdownPath, markdown)
  await writeAtomically(sourceMapPath, sourceMap)
}
