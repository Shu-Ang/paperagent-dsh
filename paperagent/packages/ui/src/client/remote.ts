/** Strict client descriptors for the small PaperAgent management BFF. */

import { z } from 'zod'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { paperAgentRemoteContract } from '@paperagent/contracts'

const nonEmptyString = z.string().min(1)
const optionalString = z.string().min(1).optional()
const nullableString = z.string().min(1).nullable()
const jsonObject = z.record(z.string(), z.unknown())
const jsonArray = z.array(jsonObject)
const integer = z.number().int()
const idResult = z.object({ id: nonEmptyString }).passthrough()
const libraryResult = z.object({ id: nonEmptyString, name: nonEmptyString, paperCount: integer }).passthrough()
const indexingResult = z.object({ status: nonEmptyString, totalItems: integer, completedItems: integer, error: z.string().nullable() }).passthrough()
const paperResult = z.object({
  id: nonEmptyString, title: z.string(), authors: z.array(z.string()), year: integer.nullable(),
  parseStatus: nonEmptyString, indexing: indexingResult,
}).passthrough()
const paperDetailResult = paperResult.passthrough()
const importResult = z.object({ id: nonEmptyString, title: z.string(), duplicate: z.boolean(), parseStatus: nonEmptyString }).passthrough()
const parseJobResult = z.object({ id: nonEmptyString, paperId: nonEmptyString, status: nonEmptyString }).passthrough()
const paperFilter = z.object({ libraryId: nullableString.optional(), paperIds: z.array(nonEmptyString).optional(), section: optionalString }).passthrough()
const vectorSettingsInput = z.object({ embeddingEnabled: z.boolean(), elasticsearchEnabled: z.boolean(), rerankerEnabled: z.boolean() }).strict()
const metadataPatch = z.object({
  title: optionalString, authors: z.array(z.string()).optional(), year: integer.nullable().optional(), doi: nullableString.optional(),
  bibtex: nullableString.optional(), citationKey: nullableString.optional(), journal: nullableString.optional(), volume: nullableString.optional(),
  issue: nullableString.optional(), pages: nullableString.optional(), url: nullableString.optional(), abstract: nullableString.optional(), keywords: nullableString.optional(),
}).passthrough()

function schemaFor(method: string, parameter: string) {
  if (parameter === 'sessionId') return nonEmptyString
  if (parameter === 'name') return nonEmptyString
  if (parameter === 'paperId' || parameter === 'libraryId' || parameter === 'jobId' || parameter === 'figureId' || parameter === 'elementId') {
    return method === 'movePaper' && parameter === 'libraryId' ? nonEmptyString.nullable() : nonEmptyString
  }
  if (parameter === 'reference') return nonEmptyString
  if (parameter === 'filter') return paperFilter
  if (parameter === 'patch') return metadataPatch
  if (parameter === 'input') {
    if (method === 'setVectorSettings') return vectorSettingsInput
    if (method === 'uploadPaper') return z.object({ fileName: nonEmptyString, base64: nonEmptyString, libraryId: nullableString, title: optionalString }).passthrough()
    if (method === 'importArxivPaper') return z.object({ url: nonEmptyString, libraryId: nullableString }).passthrough()
    if (method === 'importPaperReference') return z.object({ reference: nonEmptyString, libraryId: nullableString, candidateId: optionalString }).passthrough()
    if (method === 'uploadBibtex') return z.object({ bibtex: nonEmptyString, libraryId: nullableString }).passthrough()
    if (method === 'replacePaperPdf') return z.object({ fileName: nonEmptyString, base64: nonEmptyString }).passthrough()
    if (method === 'searchPaperElements') return z.object({ query: nonEmptyString, types: z.array(nonEmptyString).optional(), limit: integer.min(1).max(20).optional(), filter: paperFilter.optional() }).passthrough()
    return jsonObject
  }
  return jsonObject
}

function resultSchema(method: string) {
  if (method === 'listLibraries') return z.array(libraryResult)
  if (method === 'listPapers') return z.array(paperResult)
  if (method === 'resolvePaperReference') return jsonArray
  if (method === 'listPaperFigures') return jsonArray
  if (method === 'searchPaperElements') return jsonArray
  if (method === 'createLibrary' || method === 'renameLibrary') return libraryResult
  if (method === 'deleteLibrary' || method === 'deletePaper') return idResult
  if (method === 'getPaper' || method === 'updatePaperMetadata' || method === 'movePaper' || method === 'replacePaperPdf') return paperDetailResult
  if (method === 'getVectorSettings' || method === 'setVectorSettings') return z.object({ embeddingEnabled: z.boolean(), elasticsearchEnabled: z.boolean(), rerankerEnabled: z.boolean() }).passthrough()
  if (method === 'createPaperPdfAccess') return z.object({ url: nonEmptyString, expiresAt: integer }).passthrough()
  if (method === 'testElasticsearch') return z.object({ nodeName: nonEmptyString, clusterName: nonEmptyString, version: nonEmptyString }).passthrough()
  if (method === 'uploadPaper' || method === 'importArxivPaper' || method === 'importPaperReference' || method === 'uploadBibtex') return importResult
  if (method === 'startParse' || method === 'getParseJob' || method === 'cancelParse') return parseJobResult
  if (method === 'reindexPaper' || method === 'getPaperIndexingStatus') return indexingResult
  if (method === 'getPaperFigureImage') return z.object({ mimeType: nonEmptyString, base64: nonEmptyString }).passthrough()
  if (method === 'retryPaperFigureDescription') return z.object({ id: nonEmptyString, status: nonEmptyString }).passthrough()
  return jsonObject
}

function call(method: string, parameters: readonly { readonly name: string; readonly schema: ReturnType<typeof schemaFor> }[]): TypertRemoteContribution['descriptors'][number] {
  return {
    id: `@paperagent/dsh-paperagent#paperAgent/${method}`,
    service: 'paperAgent', namespace: 'paperAgent', method,
    invocation: { kind: 'direct' },
    parameters: parameters.map(parameter => ({
      name: parameter.name, wire: parameter.name, source: 'json' as const,
      codec: { mode: 'strict' as const, typeSymbol: `@paperagent/dsh-paperagent/client#${method}:${parameter.name}`, schema: parameter.schema },
    })),
    result: { mode: 'strict', typeSymbol: `@paperagent/dsh-paperagent/client#${method}:result`, schema: resultSchema(method) },
  }
}

export const paperAgentRemote: TypertRemoteContribution = {
  package: '@paperagent/dsh-paperagent',
  descriptors: paperAgentRemoteContract.map(({ method, parameters }) => call(
    method,
    parameters.map(name => ({ name, schema: schemaFor(method, name) })),
  )),
}
