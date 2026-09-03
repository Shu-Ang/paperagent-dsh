import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { workspaceDataPath } from '@paperagent/domain'
import { validatePdfBytes, validatePdfFileName } from './pdf-upload-validation.ts'

export async function writeBrowserPdf(
  workspace: string,
  input: { fileName: string; base64: string },
  maxPdfBytes: number,
): Promise<string> {
  validatePdfFileName(input.fileName)
  const maxEncodedBytes = Math.ceil(maxPdfBytes / 3) * 4 + 8
  if (input.base64.length > maxEncodedBytes) throw new Error('uploaded PDF exceeds the configured size limit')
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.base64)) throw new Error('uploaded PDF is not valid Base64 data')
  const source = Buffer.from(input.base64, 'base64')
  validatePdfBytes(source, maxPdfBytes, { emptyMessage: 'uploaded PDF is empty' })
  const temporaryPath = workspaceDataPath(workspace, `uploads/${randomUUID()}.pdf`)
  await mkdir(workspaceDataPath(workspace, 'uploads'), { recursive: true })
  await writeFile(temporaryPath, source, { flag: 'wx' })
  return temporaryPath
}
