import { extname } from 'node:path'

/** Shared validation for both browser and raw HTTP PDF upload transports. */
export function validatePdfFileName(fileName: string): string {
  if (extname(fileName).toLowerCase() !== '.pdf') throw new Error('only .pdf files can be uploaded')
  return fileName
}

export function validatePdfBytes(bytes: Uint8Array, maxBytes: number, messages: {
  readonly emptyMessage?: string
  readonly invalidMessage?: string
} = {}): void {
  if (bytes.length > maxBytes) throw new Error('uploaded PDF exceeds the configured size limit')
  if (bytes.length === 0) throw new Error(messages.emptyMessage ?? 'uploaded file is not a PDF document')
  const signature = Buffer.from('%PDF-')
  if (bytes.length < signature.length || !bytes.subarray(0, signature.length).every((value, index) => value === signature[index])) throw new Error(messages.invalidMessage ?? 'uploaded file is not a PDF document')
}
