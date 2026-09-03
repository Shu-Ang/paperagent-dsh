import { inflateRawSync } from 'node:zlib'

const MAX_EXTRACTED_BYTES = 1024 * 1024 * 1024

export function readZipArchive(bytes: Uint8Array): ReadonlyMap<string, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const eocd = findEndOfCentralDirectory(view)
  const entryCount = view.getUint16(eocd + 10, true)
  const directoryOffset = view.getUint32(eocd + 16, true)
  let offset = directoryOffset
  let totalSize = 0
  const files = new Map<string, Uint8Array>()
  for (let index = 0; index < entryCount; index += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) throw new Error('invalid MinerU ZIP central-directory entry')
    const compression = view.getUint16(offset + 10, true)
    const compressedSize = view.getUint32(offset + 20, true)
    const uncompressedSize = view.getUint32(offset + 24, true)
    const nameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    const commentLength = view.getUint16(offset + 32, true)
    const localOffset = view.getUint32(offset + 42, true)
    const name = new TextDecoder().decode(bytes.slice(offset + 46, offset + 46 + nameLength))
    assertSafeArchivePath(name)
    totalSize += uncompressedSize
    if (totalSize > MAX_EXTRACTED_BYTES) throw new Error('MinerU result archive exceeds the local extraction safety limit')
    if (!name.endsWith('/')) {
      if (view.getUint32(localOffset, true) !== 0x04034b50) throw new Error('invalid MinerU ZIP local entry')
      const localNameLength = view.getUint16(localOffset + 26, true)
      const localExtraLength = view.getUint16(localOffset + 28, true)
      const dataStart = localOffset + 30 + localNameLength + localExtraLength
      const compressed = bytes.slice(dataStart, dataStart + compressedSize)
      const content = compression === 0 ? compressed : compression === 8 ? new Uint8Array(inflateRawSync(compressed)) : undefined
      if (content === undefined) throw new Error(`unsupported MinerU ZIP compression method ${compression}`)
      if (content.byteLength !== uncompressedSize) throw new Error(`invalid MinerU ZIP entry size for ${name}`)
      files.set(name, content)
    }
    offset += 46 + nameLength + extraLength + commentLength
  }
  return files
}

function findEndOfCentralDirectory(view: DataView): number {
  for (let offset = view.byteLength - 22; offset >= Math.max(0, view.byteLength - 65_557); offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) return offset
  }
  throw new Error('invalid MinerU ZIP: end of central directory not found')
}

function assertSafeArchivePath(path: string): void {
  if (path === '' || path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z]:/.test(path) || path.split(/[\\/]/).includes('..')) {
    throw new Error('MinerU result archive contains an unsafe path')
  }
}

export function requireArchiveText(files: ReadonlyMap<string, Uint8Array>, matcher: RegExp, label: string): string {
  const entry = [...files.entries()].find(([name]) => matcher.test(name))
  if (entry === undefined) throw new Error(`MinerU result archive is missing ${label}`)
  return new TextDecoder().decode(entry[1])
}

export function findArchiveJson(files: ReadonlyMap<string, Uint8Array>, matcher: RegExp): unknown | undefined {
  const entry = [...files.entries()].find(([name]) => matcher.test(name))
  if (entry === undefined) return undefined
  try {
    return JSON.parse(new TextDecoder().decode(entry[1]))
  } catch {
    throw new Error(`MinerU archive contains invalid JSON in ${entry[0]}`)
  }
}

