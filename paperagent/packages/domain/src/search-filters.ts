import { STRUCTURED_PAPER_ELEMENT_TYPES, type PaperElementType, type PaperSearchFilter } from './models.ts'

export function chunkFilterSql(workspace: string, filter: PaperSearchFilter, chunkAlias = 'c', paperAlias = 'p'): {
  readonly where: string
  readonly parameters: readonly string[]
} {
  const clauses = [`${chunkAlias}.workspace_path = ?`, `${paperAlias}.parse_status = 'ready'`, `COALESCE(${chunkAlias}.chunk_type, 'child') = 'child'`]
  const parameters: string[] = [workspace]
  if (filter.libraryId !== undefined) {
    clauses.push(`${paperAlias}.library_id = ?`)
    parameters.push(filter.libraryId)
  }
  const paperIds = [...new Set(filter.paperIds ?? [])].filter(id => id.trim() !== '').slice(0, 100)
  if (paperIds.length > 0) {
    clauses.push(`${chunkAlias}.paper_id IN (${paperIds.map(() => '?').join(', ')})`)
    parameters.push(...paperIds)
  }
  if (filter.section !== undefined && filter.section.trim() !== '') {
    const section = filter.section.trim()
    const escapedSection = escapeLike(section)
    // Section values are stored as a stable path. Match the requested node
    // itself and all descendants without duplicating parent text in chunks.
    clauses.push(`(${chunkAlias}.section = ? OR ${chunkAlias}.section LIKE ? ESCAPE '\\' OR ${chunkAlias}.section LIKE ? ESCAPE '\\' OR ${chunkAlias}.section LIKE ? ESCAPE '\\')`)
    parameters.push(section, `% > ${escapedSection}`, `% > ${escapedSection} > %`, `${escapedSection} > %`)
  }
  return { where: clauses.join(' AND '), parameters }
}

export function elementFilterSql(workspace: string, types: readonly PaperElementType[], filter: PaperSearchFilter = {}, elementAlias = 'e', paperAlias = 'p'): {
  readonly where: string
  readonly parameters: readonly (string | number)[]
} {
  const clauses = [`${elementAlias}.workspace_path = ?`, `${paperAlias}.parse_status = 'ready'`]
  const parameters: Array<string | number> = [workspace]
  const requested = [...new Set(types)].filter((type): type is PaperElementType => STRUCTURED_PAPER_ELEMENT_TYPES.includes(type))
  const effectiveTypes = types.length === 0 ? STRUCTURED_PAPER_ELEMENT_TYPES : requested
  if (effectiveTypes.length === 0) {
    clauses.push('1 = 0')
  } else {
    clauses.push(`${elementAlias}.element_type IN (${effectiveTypes.map(() => '?').join(', ')})`)
    parameters.push(...effectiveTypes)
  }
  if (filter.libraryId !== undefined) {
    clauses.push(`${paperAlias}.library_id = ?`)
    parameters.push(filter.libraryId)
  }
  const paperIds = [...new Set(filter.paperIds ?? [])].filter(id => id.trim() !== '').slice(0, 100)
  if (paperIds.length > 0) {
    clauses.push(`${elementAlias}.paper_id IN (${paperIds.map(() => '?').join(', ')})`)
    parameters.push(...paperIds)
  }
  if (filter.section !== undefined && filter.section.trim() !== '') {
    const section = filter.section.trim()
    const escapedSection = escapeLike(section)
    clauses.push(`(${elementAlias}.section = ? OR ${elementAlias}.section LIKE ? ESCAPE '\\' OR ${elementAlias}.section LIKE ? ESCAPE '\\' OR ${elementAlias}.section LIKE ? ESCAPE '\\')`)
    parameters.push(section, `% > ${escapedSection}`, `% > ${escapedSection} > %`, `${escapedSection} > %`)
  }
  return { where: clauses.join(' AND '), parameters }
}

/** Treat user supplied section filters as literal path segments, not LIKE patterns. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, character => `\\${character}`)
}
