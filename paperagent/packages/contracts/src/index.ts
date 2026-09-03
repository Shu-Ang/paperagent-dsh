/**
 * The one source of truth for PaperAgent's browser-to-Host method names and
 * business argument order. Keep this package browser-safe: no Node APIs,
 * filesystem paths, or database types may be imported here.
 */
export * from './paper-citations.ts'
export * from './paper-retrieval-trace.ts'

export const paperAgentRemoteContract = [
  { method: 'listLibraries', parameters: ['sessionId'] },
  // Keep every browser-facing operation session-shaped. The DSH remote
  // descriptor does not safely support a zero-argument operation here.
  { method: 'getVectorSettings', parameters: ['sessionId'] },
  { method: 'setVectorSettings', parameters: ['sessionId', 'input'] },
  { method: 'createLibrary', parameters: ['sessionId', 'name'] },
  { method: 'renameLibrary', parameters: ['sessionId', 'libraryId', 'name'] },
  { method: 'deleteLibrary', parameters: ['sessionId', 'libraryId'] },
  { method: 'listPapers', parameters: ['sessionId', 'filter'] },
  { method: 'getPaper', parameters: ['sessionId', 'paperId'] },
  { method: 'getPaperParseStructure', parameters: ['sessionId', 'paperId'] },
  { method: 'createPaperPdfAccess', parameters: ['sessionId', 'paperId'] },
  // Keep the session-shaped Remote signature used by every browser-facing
  // PaperAgent operation. Some DSH client descriptor paths do not safely
  // materialize a zero-argument contribution beside session-scoped methods.
  { method: 'testElasticsearch', parameters: ['sessionId'] },
  { method: 'updatePaperMetadata', parameters: ['sessionId', 'paperId', 'patch'] },
  { method: 'movePaper', parameters: ['sessionId', 'paperId', 'libraryId'] },
  { method: 'deletePaper', parameters: ['sessionId', 'paperId'] },
  { method: 'uploadPaper', parameters: ['sessionId', 'input'] },
  { method: 'importArxivPaper', parameters: ['sessionId', 'input'] },
  { method: 'resolvePaperReference', parameters: ['sessionId', 'reference'] },
  { method: 'importPaperReference', parameters: ['sessionId', 'input'] },
  { method: 'uploadBibtex', parameters: ['sessionId', 'input'] },
  { method: 'replacePaperPdf', parameters: ['sessionId', 'paperId', 'input'] },
  { method: 'startParse', parameters: ['sessionId', 'paperId'] },
  { method: 'reindexPaper', parameters: ['sessionId', 'paperId'] },
  { method: 'getPaperIndexingStatus', parameters: ['sessionId', 'paperId'] },
  { method: 'getParseJob', parameters: ['sessionId', 'jobId'] },
  { method: 'cancelParse', parameters: ['sessionId', 'jobId'] },
  { method: 'listPaperFigures', parameters: ['sessionId', 'paperId'] },
  { method: 'getPaperFigureImage', parameters: ['sessionId', 'figureId'] },
  { method: 'retryPaperFigureDescription', parameters: ['sessionId', 'figureId'] },
  { method: 'searchPaperElements', parameters: ['sessionId', 'input'] },
  { method: 'readPaperElement', parameters: ['sessionId', 'elementId'] },
] as const satisfies readonly { readonly method: string; readonly parameters: readonly string[] }[]

export type PaperAgentRemoteMethod = (typeof paperAgentRemoteContract)[number]['method']

export function paperAgentRemoteParameters(method: PaperAgentRemoteMethod): readonly string[] {
  const entry = paperAgentRemoteContract.find(item => item.method === method)
  if (entry === undefined) throw new Error(`unknown PaperAgent Remote method: ${method}`)
  return entry.parameters
}
