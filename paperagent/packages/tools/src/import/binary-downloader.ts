/** Safe, bounded download of one public PDF into PaperAgent staging storage. */

import { createHash, randomUUID } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { mkdir, open, rename, rm } from 'node:fs/promises'
import { request } from 'node:https'
import type { IncomingMessage } from 'node:http'
import { isIP } from 'node:net'
import { workspaceDataPath } from '@paperagent/domain'

export interface PublicPdfDownloadOptions {
  readonly workspacePath: string
  readonly url: string
  readonly maxBytes: number
  readonly timeoutMs?: number
  readonly maxRedirects?: number
  readonly preferredFileName?: string
}

export interface DownloadedPublicPdf {
  readonly localPath: string
  readonly fileName: string
  readonly finalUrl: string
  readonly sha256: string
  cleanup(): Promise<void>
}

interface ApprovedUrl {
  readonly url: URL
  /** Exact address approved by DNS/IP policy and used for the TLS connection. */
  readonly address: string
  readonly family: 4 | 6
}

const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_MAX_REDIRECTS = 3
const MAX_RESPONSE_HEADER_BYTES = 16 * 1024

/**
 * Downloads an unauthenticated public PDF to a per-operation staging directory.
 * DNS is resolved before every request (including redirects), then HTTPS connects
 * to that approved address while preserving the original Host/SNI. This removes
 * the DNS-rebinding gap between validation and connection.
 */
export async function downloadPublicPdf(options: PublicPdfDownloadOptions): Promise<DownloadedPublicPdf> {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0) throw new Error('PDF download maxBytes must be a positive integer')
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('PDF download timeoutMs must be a positive integer')
  if (!Number.isSafeInteger(maxRedirects) || maxRedirects < 0) throw new Error('PDF download maxRedirects must be a non-negative integer')

  let url: URL
  try { url = new URL(options.url.trim()) } catch { throw new Error('please provide a valid HTTPS PDF URL') }
  const visited = new Set<string>()
  for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
    const approved = await approvePublicHttpsUrl(url, timeoutMs)
    const identity = url.toString()
    if (visited.has(identity)) throw new Error('PDF URL redirect loop detected')
    visited.add(identity)

    const response = await requestPinnedHttps(approved, timeoutMs)
    if (isRedirect(response.statusCode ?? 0)) {
      const location = response.headers.location
      response.resume()
      if (location === undefined || location.trim() === '') throw new Error('PDF URL redirect is missing a Location header')
      url = new URL(location, url)
      continue
    }
    if ((response.statusCode ?? 0) < 200 || (response.statusCode ?? 0) >= 300) {
      response.resume()
      throw new Error(`PDF URL download failed with HTTP ${response.statusCode ?? 0}`)
    }
    const contentLength = response.headers['content-length']
    if (contentLength !== undefined) {
      const declaredBytes = Number(contentLength)
      if (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0) {
        response.resume()
        throw new Error('PDF URL returned an invalid Content-Length header')
      }
      if (declaredBytes > options.maxBytes) {
        response.resume()
        throw new Error(`PDF URL exceeds the configured ${options.maxBytes}-byte limit`)
      }
    }
    return writePdfResponse(options.workspacePath, response, options.maxBytes, url, options.preferredFileName)
  }
  throw new Error(`PDF URL exceeded the maximum of ${maxRedirects} redirects`)
}

async function requestPinnedHttps(approved: ApprovedUrl, timeoutMs: number): Promise<IncomingMessage> {
  return new Promise<IncomingMessage>((resolve, reject) => {
    const requestHandle = request({
      protocol: 'https:',
      hostname: approved.address,
      family: approved.family,
      port: approved.url.port === '' ? 443 : Number(approved.url.port),
      path: `${approved.url.pathname}${approved.url.search}`,
      method: 'GET',
      agent: false,
      servername: approved.url.hostname.replace(/^\[|\]$/g, ''),
      headers: { host: approved.url.host, accept: 'application/pdf, application/octet-stream;q=0.8' },
      maxHeaderSize: MAX_RESPONSE_HEADER_BYTES,
      timeout: timeoutMs,
    }, resolve)
    requestHandle.once('timeout', () => requestHandle.destroy(new Error(`PDF URL request timed out after ${timeoutMs}ms`)))
    requestHandle.once('error', reject)
    requestHandle.end()
  })
}

async function writePdfResponse(
  workspacePath: string,
  response: IncomingMessage,
  maxBytes: number,
  finalUrl: URL,
  preferredFileName: string | undefined,
): Promise<DownloadedPublicPdf> {
  const operationDirectory = workspaceDataPath(workspacePath, `staging/${randomUUID()}`)
  const partPath = `${operationDirectory}/paper.pdf.part`
  const localPath = `${operationDirectory}/paper.pdf`
  await mkdir(operationDirectory, { recursive: true })
  const handle = await open(partPath, 'wx')
  const hash = createHash('sha256')
  const prefix: Buffer[] = []
  let prefixBytes = 0
  let total = 0
  try {
    for await (const value of response) {
      const chunk = Buffer.from(value)
      total += chunk.byteLength
      if (total > maxBytes) throw new Error(`PDF URL exceeds the configured ${maxBytes}-byte limit`)
      hash.update(chunk)
      if (prefixBytes < 5) {
        prefix.push(chunk)
        prefixBytes += chunk.byteLength
      }
      await handle.write(chunk)
    }
    if (total === 0) throw new Error('PDF URL returned an empty document')
    if (!Buffer.concat(prefix).subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('URL did not return a PDF document')
    await handle.close()
    await rename(partPath, localPath)
  } catch (error) {
    response.destroy()
    await handle.close().catch(() => undefined)
    await rm(operationDirectory, { recursive: true, force: true })
    throw error
  }
  return {
    localPath,
    fileName: sanitizePdfFileName(preferredFileName ?? fileNameForUrl(finalUrl)),
    finalUrl: finalUrl.toString(),
    sha256: hash.digest('hex'),
    cleanup: async () => { await rm(operationDirectory, { recursive: true, force: true }) },
  }
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

async function approvePublicHttpsUrl(url: URL, timeoutMs: number): Promise<ApprovedUrl> {
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') throw new Error('only HTTPS PDF URLs without account information are supported')
  if (url.port !== '' && (Number(url.port) < 1 || Number(url.port) > 65535)) throw new Error('PDF URL contains an invalid port')
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) throw new Error('PDF URL must resolve to a public internet host')
  const addresses = isIP(hostname) === 0
    ? await Promise.race([
      lookup(hostname, { all: true, verbatim: true }),
      rejectAfter(timeoutMs, `PDF URL DNS lookup timed out after ${timeoutMs}ms`),
    ])
    : [{ address: hostname, family: isIP(hostname) as 4 | 6 }]
  if (addresses.length === 0 || addresses.some(address => !isPublicInternetAddress(address.address))) {
    throw new Error('PDF URL must resolve only to public internet addresses')
  }
  const selected = addresses[0]!
  return { url, address: selected.address, family: selected.family as 4 | 6 }
}

function rejectAfter<T = never>(timeoutMs: number, message: string): Promise<T> {
  return new Promise((_, reject) => { setTimeout(() => reject(new Error(message)), timeoutMs).unref() })
}

/** Exported for regression tests and for any future non-PDF public downloader. */
export function isPublicInternetAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return !isSpecialIpv4(address)
  if (family === 6) return !isSpecialIpv6(address)
  return false
}

function isSpecialIpv4(address: string): boolean {
  const [a = 0, b = 0] = address.split('.').map(Number)
  return a === 0 || a === 10 || a === 100 && b >= 64 && b <= 127 || a === 127 ||
    a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 0 || b === 2 || b === 88 || b === 168) ||
    a === 198 && (b === 18 || b === 19 || b === 51) || a === 203 && b === 0 || a >= 224
}

function isSpecialIpv6(address: string): boolean {
  const words = ipv6Words(address)
  if (words === undefined) return true
  if (words.every(word => word === 0) || words.slice(0, 7).every(word => word === 0) && words[7] === 1) return true
  if ((words[0]! & 0xfe00) === 0xfc00 || (words[0]! & 0xffc0) === 0xfe80 || (words[0]! & 0xff00) === 0xff00) return true
  if (words[0] === 0x2001 && (words[1] === 0x0db8 || words[1] === 0x0000)) return true
  const isV4Mapped = words.slice(0, 5).every(word => word === 0) && words[5] === 0xffff
  const isV4Compatible = words.slice(0, 6).every(word => word === 0)
  if (isV4Mapped || isV4Compatible) {
    const embedded = `${words[6]! >> 8}.${words[6]! & 0xff}.${words[7]! >> 8}.${words[7]! & 0xff}`
    return isSpecialIpv4(embedded)
  }
  return false
}

function ipv6Words(address: string): number[] | undefined {
  const normalized = address.toLowerCase().split('%', 1)[0]!
  const ipv4Match = normalized.match(/(.*:)(\d+\.\d+\.\d+\.\d+)$/)
  const ipv4Words = ipv4Match === null ? undefined : ipv4ToWords(ipv4Match[2]!)
  if (ipv4Match !== null && ipv4Words === undefined) return undefined
  const withWords = ipv4Match === null ? normalized : `${ipv4Match[1]}${ipv4Words}`
  const halves = withWords.split('::')
  if (halves.length > 2) return undefined
  const left = halves[0] === '' ? [] : halves[0]!.split(':')
  const right = halves.length === 1 || halves[1] === '' ? [] : halves[1]!.split(':')
  if (left.some(isInvalidHextet) || right.some(isInvalidHextet)) return undefined
  if (halves.length === 1 && left.length !== 8) return undefined
  if (halves.length === 2 && left.length + right.length >= 8) return undefined
  return [...left, ...Array(8 - left.length - right.length).fill('0'), ...right].map(value => Number.parseInt(value, 16))
}

function ipv4ToWords(address: string): string | undefined {
  const parts = address.split('.').map(Number)
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return undefined
  return `${((parts[0]! << 8) | parts[1]!).toString(16)}:${((parts[2]! << 8) | parts[3]!).toString(16)}`
}

function isInvalidHextet(value: string): boolean {
  return !/^[0-9a-f]{1,4}$/i.test(value)
}

function fileNameForUrl(url: URL): string {
  return decodeURIComponent(url.pathname).split('/').filter(Boolean).at(-1) ?? 'download.pdf'
}

function sanitizePdfFileName(value: string): string {
  const safe = value.replace(/[\\/:*?"<>|]/g, '-').trim()
  return safe.toLowerCase().endsWith('.pdf') ? safe : 'download.pdf'
}
