import type { DatabaseSync } from 'node:sqlite'
import { resolve } from 'node:path'

// Version 2 is the first version that records the post-MinerU schema
// additions (sections, structured elements, references, durable workers and
// FTS health state). The column/table guards below perform the actual
// idempotent upgrade; this marker must still advance so a future runtime can
// reject a genuinely newer database instead of reporting every schema as v1.
const SCHEMA_VERSION = 3

export function initializeSchema(db: DatabaseSync): boolean {
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
  db.exec(`
    CREATE TABLE IF NOT EXISTS libraries (
      id TEXT PRIMARY KEY,
      workspace_path TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(workspace_path, name)
    );
    CREATE TABLE IF NOT EXISTS papers (
      id TEXT PRIMARY KEY,
      workspace_path TEXT NOT NULL,
      library_id TEXT REFERENCES libraries(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      authors TEXT NOT NULL,
      year INTEGER,
      doi TEXT,
      bibtex TEXT,
      citation_key TEXT,
      journal TEXT,
      volume TEXT,
      issue TEXT,
      pages TEXT,
      url TEXT,
      abstract TEXT,
      keywords TEXT,
      pdf_source_url TEXT,
      bibtex_source_url TEXT,
      source_adapter TEXT,
      metadata_provenance_json TEXT,
      file_hash TEXT NOT NULL,
      relative_dir TEXT NOT NULL,
      original_file_name TEXT NOT NULL,
      parse_status TEXT NOT NULL,
      parse_error TEXT,
      parser_version TEXT,
      parse_revision TEXT,
      parsed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(workspace_path, file_hash)
    );
    CREATE INDEX IF NOT EXISTS idx_papers_workspace_library
      ON papers(workspace_path, library_id);
    CREATE TABLE IF NOT EXISTS paper_chunks (
      id TEXT PRIMARY KEY,
      paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
      workspace_path TEXT NOT NULL,
      section TEXT NOT NULL,
      section_id TEXT,
      parent_section_id TEXT,
      chunk_type TEXT NOT NULL DEFAULT 'child',
      sequence INTEGER NOT NULL DEFAULT 0,
      pdf_page_start INTEGER NOT NULL,
      pdf_page_end INTEGER NOT NULL,
      line_start INTEGER NOT NULL,
      line_end INTEGER NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_paper_chunks_workspace_paper
      ON paper_chunks(workspace_path, paper_id);
    CREATE TABLE IF NOT EXISTS paper_sections (
      id TEXT PRIMARY KEY,
      paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
      workspace_path TEXT NOT NULL,
      title TEXT NOT NULL,
      level INTEGER NOT NULL,
      parent_id TEXT REFERENCES paper_sections(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      pdf_page_start INTEGER NOT NULL,
      pdf_page_end INTEGER NOT NULL,
      line_start INTEGER NOT NULL,
      line_end INTEGER NOT NULL,
      reading_order INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(workspace_path, paper_id, id)
    );
    CREATE INDEX IF NOT EXISTS idx_paper_sections_workspace_paper
      ON paper_sections(workspace_path, paper_id, reading_order);
    CREATE TABLE IF NOT EXISTS paper_elements (
      id TEXT PRIMARY KEY,
      paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
      workspace_path TEXT NOT NULL,
      element_type TEXT NOT NULL,
      section TEXT NOT NULL,
      section_id TEXT,
      parent_section_id TEXT,
      pdf_page_start INTEGER NOT NULL,
      pdf_page_end INTEGER NOT NULL,
      line_start INTEGER,
      line_end INTEGER,
      reading_order INTEGER NOT NULL,
      content TEXT NOT NULL,
      caption TEXT,
      content_format TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_paper_elements_workspace_paper
      ON paper_elements(workspace_path, paper_id, element_type);
    CREATE TABLE IF NOT EXISTS paper_references (
      id TEXT PRIMARY KEY,
      paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
      workspace_path TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      label TEXT,
      raw_text TEXT NOT NULL,
      authors_json TEXT NOT NULL,
      title TEXT,
      year INTEGER,
      venue TEXT,
      doi TEXT,
      url TEXT,
      section TEXT NOT NULL,
      pdf_page_start INTEGER NOT NULL,
      pdf_page_end INTEGER NOT NULL,
      line_start INTEGER,
      line_end INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(workspace_path, paper_id, ordinal)
    );
    CREATE INDEX IF NOT EXISTS idx_paper_references_workspace_paper
      ON paper_references(workspace_path, paper_id, ordinal);
    CREATE TABLE IF NOT EXISTS paper_chunk_elements (
      chunk_id TEXT NOT NULL REFERENCES paper_chunks(id) ON DELETE CASCADE,
      element_id TEXT NOT NULL REFERENCES paper_elements(id) ON DELETE CASCADE,
      PRIMARY KEY (chunk_id, element_id)
    );
    CREATE TABLE IF NOT EXISTS paper_figures (
      id TEXT PRIMARY KEY,
      paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
      workspace_path TEXT NOT NULL,
      element_id TEXT UNIQUE REFERENCES paper_elements(id) ON DELETE SET NULL,
      figure_label TEXT,
      page_number INTEGER NOT NULL,
      section_title TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      raw_caption TEXT NOT NULL,
      nearby_text TEXT NOT NULL,
      vision_description TEXT,
      vision_status TEXT NOT NULL,
      vision_model TEXT,
      vision_prompt_version TEXT,
      vision_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(paper_id, relative_path)
    );
    CREATE TABLE IF NOT EXISTS paper_parse_jobs (
      id TEXT PRIMARY KEY,
      workspace_path TEXT NOT NULL,
      paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      current_page INTEGER,
      total_pages INTEGER,
      chunk_count INTEGER,
      error TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_paper_parse_jobs_active
      ON paper_parse_jobs(workspace_path, paper_id, status, created_at DESC);
    CREATE TABLE IF NOT EXISTS paper_vision_jobs (
      id TEXT PRIMARY KEY,
      workspace_path TEXT NOT NULL,
      figure_id TEXT NOT NULL REFERENCES paper_figures(id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      error TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_paper_vision_jobs_active
      ON paper_vision_jobs(workspace_path, figure_id, status, created_at DESC);
    CREATE TABLE IF NOT EXISTS paper_embedding_jobs (
      id TEXT PRIMARY KEY,
      workspace_path TEXT NOT NULL,
      paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
      parse_revision TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      status TEXT NOT NULL,
      total_items INTEGER NOT NULL DEFAULT 0,
      completed_items INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      updated_at TEXT NOT NULL,
      UNIQUE(workspace_path, paper_id, parse_revision, provider, model, dimensions)
    );
    CREATE INDEX IF NOT EXISTS idx_paper_embedding_jobs_active
      ON paper_embedding_jobs(workspace_path, status, created_at ASC);
    CREATE TABLE IF NOT EXISTS paperagent_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_paper_figures_workspace_paper
      ON paper_figures(workspace_path, paper_id);
  `)
  ensurePaperColumns(db)
  ensureElementColumns(db)
  ensureChunkColumns(db)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_paper_chunks_section ON paper_chunks(workspace_path, paper_id, section_id, sequence);`)
  ensureSchemaVersion(db)
  normalizeWorkspacePaths(db)
  return ensureChunkFts(db)
}

/**
 * Canonical workspace paths became case-insensitive on Windows in schema v3.
 * Older databases may contain the same path with a different drive-letter or
 * directory casing, which would otherwise make all workspace-scoped queries
 * appear empty after upgrading. Rebuildable FTS projections are included so
 * their stored metadata stays consistent with the authoritative rows.
 */
function normalizeWorkspacePaths(db: DatabaseSync): void {
  if (process.platform !== 'win32') return
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as unknown as Array<{ name: string }>
  const workspaceTables: string[] = []
  for (const row of tables) {
    const identifier = row.name.replaceAll('"', '""')
    const columns = db.prepare(`PRAGMA table_info("${identifier}")`).all() as unknown as Array<{ name: string }>
    if (columns.some(column => column.name === 'workspace_path')) workspaceTables.push(identifier)
  }
  const changes: Array<{ readonly table: string; readonly from: string; readonly to: string }> = []
  for (const table of workspaceTables) {
    const rows = db.prepare(`SELECT DISTINCT workspace_path FROM "${table}"`).all() as unknown as Array<{ workspace_path: string }>
    for (const row of rows) {
      const canonical = resolve(row.workspace_path).replaceAll('\\', '/').toLowerCase()
      if (canonical !== row.workspace_path) changes.push({ table, from: row.workspace_path, to: canonical })
    }
  }
  if (changes.length === 0) return
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const change of changes) db.prepare(`UPDATE "${change.table}" SET workspace_path = ? WHERE workspace_path = ?`).run(change.to, change.from)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

/** Records the schema level so future structural changes can be explicit migrations. */
function ensureSchemaVersion(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS paperagent_schema_meta (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      version INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );
  `)
  const row = db.prepare('SELECT version FROM paperagent_schema_meta WHERE singleton = 1').get() as { version: number } | undefined
  if (row !== undefined && row.version > SCHEMA_VERSION) {
    throw new Error(`PaperAgent database schema v${row.version} is newer than this runtime (v${SCHEMA_VERSION})`)
  }
  db.prepare(`INSERT INTO paperagent_schema_meta (singleton, version, updated_at) VALUES (1, ?, ?)
    ON CONFLICT(singleton) DO UPDATE SET version = excluded.version, updated_at = excluded.updated_at`)
    .run(SCHEMA_VERSION, new Date().toISOString())
}

function ensureChunkColumns(db: DatabaseSync): void {
  const rows = db.prepare('PRAGMA table_info(paper_chunks)').all() as unknown as Array<{ name: string }>
  const present = new Set(rows.map(row => row.name))
  const additions: ReadonlyArray<readonly [string, string]> = [
    ['section_id', 'TEXT'], ['parent_section_id', 'TEXT'], ['chunk_type', "TEXT NOT NULL DEFAULT 'child'"], ['sequence', 'INTEGER NOT NULL DEFAULT 0'],
  ]
  for (const [name, type] of additions) if (!present.has(name)) db.exec(`ALTER TABLE paper_chunks ADD COLUMN ${name} ${type}`)
}

function ensurePaperColumns(db: DatabaseSync): void {
  const rows = db.prepare('PRAGMA table_info(papers)').all() as unknown as Array<{ name: string }>
  const present = new Set(rows.map(row => row.name))
  const additions: ReadonlyArray<readonly [string, string]> = [
    ['citation_key', 'TEXT'], ['journal', 'TEXT'], ['volume', 'TEXT'], ['issue', 'TEXT'], ['pages', 'TEXT'],
    ['url', 'TEXT'], ['abstract', 'TEXT'], ['keywords', 'TEXT'],
    ['pdf_source_url', 'TEXT'], ['bibtex_source_url', 'TEXT'], ['source_adapter', 'TEXT'], ['metadata_provenance_json', 'TEXT'], ['parse_revision', 'TEXT'],
  ]
  for (const [name, type] of additions) {
    if (!present.has(name)) db.exec(`ALTER TABLE papers ADD COLUMN ${name} ${type}`)
  }
}

function ensureElementColumns(db: DatabaseSync): void {
  const figureColumns = db.prepare('PRAGMA table_info(paper_figures)').all() as unknown as Array<{ name: string }>
  const present = new Set(figureColumns.map(row => row.name))
  if (!present.has('element_id')) db.exec('ALTER TABLE paper_figures ADD COLUMN element_id TEXT REFERENCES paper_elements(id) ON DELETE SET NULL')
  const elementColumns = db.prepare('PRAGMA table_info(paper_elements)').all() as unknown as Array<{ name: string }>
  const elementPresent = new Set(elementColumns.map(row => row.name))
  if (!elementPresent.has('section_id')) db.exec('ALTER TABLE paper_elements ADD COLUMN section_id TEXT')
  if (!elementPresent.has('parent_section_id')) db.exec('ALTER TABLE paper_elements ADD COLUMN parent_section_id TEXT')
  if (elementColumns.some(row => row.name === 'bbox_json')) db.exec('UPDATE paper_elements SET bbox_json = NULL WHERE bbox_json IS NOT NULL')
}

/** Create the derived index when this Node SQLite build ships FTS5. */
function ensureChunkFts(db: DatabaseSync): boolean {
  const stateTable = `
    CREATE TABLE IF NOT EXISTS paperagent_fts_state (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      status TEXT NOT NULL,
      error TEXT,
      updated_at TEXT NOT NULL
    );
  `
  try {
    db.exec(stateTable)
    // FTS tables are rebuildable projections. Older PaperAgent versions used
    // a smaller column set, and `CREATE VIRTUAL TABLE IF NOT EXISTS` does not
    // migrate those definitions. Drop only a schema-incompatible projection;
    // the source tables remain authoritative and are rebuilt below.
    ensureFtsTableShape(db, 'paper_chunks_fts', ['chunk_id', 'paper_id', 'workspace_path', 'content'])
    ensureFtsTableShape(db, 'paper_elements_fts', ['element_id', 'paper_id', 'workspace_path', 'element_type', 'content', 'caption', 'section'])
    ensureFtsTableShape(db, 'paper_figures_fts', ['figure_id', 'paper_id', 'workspace_path', 'content'])
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS paper_chunks_fts
      USING fts5(chunk_id UNINDEXED, paper_id UNINDEXED, workspace_path UNINDEXED, content, tokenize = 'unicode61 remove_diacritics 2');
      CREATE VIRTUAL TABLE IF NOT EXISTS paper_elements_fts
      USING fts5(element_id UNINDEXED, paper_id UNINDEXED, workspace_path UNINDEXED, element_type UNINDEXED, content, caption, section, tokenize = 'unicode61 remove_diacritics 2');
      CREATE VIRTUAL TABLE IF NOT EXISTS paper_figures_fts
      USING fts5(figure_id UNINDEXED, paper_id UNINDEXED, workspace_path UNINDEXED, content, tokenize = 'unicode61 remove_diacritics 2');
    `)
    const state = db.prepare('SELECT status FROM paperagent_fts_state WHERE singleton = 1').get() as { status: string } | undefined
    const sourceCounts = {
      chunks: (db.prepare('SELECT count(*) AS count FROM paper_chunks').get() as { count: number }).count,
      elements: (db.prepare('SELECT count(*) AS count FROM paper_elements').get() as { count: number }).count,
      figures: (db.prepare('SELECT count(*) AS count FROM paper_figures').get() as { count: number }).count,
    }
    const indexedCounts = {
      chunks: (db.prepare('SELECT count(*) AS count FROM paper_chunks_fts').get() as { count: number }).count,
      elements: (db.prepare('SELECT count(*) AS count FROM paper_elements_fts').get() as { count: number }).count,
      figures: (db.prepare('SELECT count(*) AS count FROM paper_figures_fts').get() as { count: number }).count,
    }
    const healthy = state?.status === 'ready'
      && sourceCounts.chunks === indexedCounts.chunks
      && sourceCounts.elements === indexedCounts.elements
      && sourceCounts.figures === indexedCounts.figures
    if (healthy) return true

    db.prepare(`INSERT INTO paperagent_fts_state (singleton, status, error, updated_at) VALUES (1, 'building', NULL, ?)
      ON CONFLICT(singleton) DO UPDATE SET status = 'building', error = NULL, updated_at = excluded.updated_at`)
      .run(new Date().toISOString())
    const rows = db.prepare('SELECT id, paper_id, workspace_path, content FROM paper_chunks').all() as unknown as Array<{ id: string; paper_id: string; workspace_path: string; content: string }>
    const elements = db.prepare('SELECT id, paper_id, workspace_path, element_type, content, caption, section FROM paper_elements').all() as unknown as Array<{ id: string; paper_id: string; workspace_path: string; element_type: string; content: string; caption: string | null; section: string }>
    const figures = db.prepare('SELECT id, paper_id, workspace_path, figure_label, section_title, raw_caption, nearby_text, vision_description FROM paper_figures').all() as unknown as Array<{ id: string; paper_id: string; workspace_path: string; figure_label: string | null; section_title: string; raw_caption: string; nearby_text: string; vision_description: string | null }>
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec('DELETE FROM paper_chunks_fts; DELETE FROM paper_elements_fts; DELETE FROM paper_figures_fts;')
      const insert = db.prepare('INSERT INTO paper_chunks_fts (chunk_id, paper_id, workspace_path, content) VALUES (?, ?, ?, ?)')
      for (const row of rows) insert.run(row.id, row.paper_id, row.workspace_path, ftsIndexedText(row.content))
      const insertElement = db.prepare('INSERT INTO paper_elements_fts (element_id, paper_id, workspace_path, element_type, content, caption, section) VALUES (?, ?, ?, ?, ?, ?, ?)')
      for (const element of elements) insertElement.run(element.id, element.paper_id, element.workspace_path, element.element_type, ftsIndexedText(element.content), element.caption ?? '', element.section)
      const insertFigure = db.prepare('INSERT INTO paper_figures_fts (figure_id, paper_id, workspace_path, content) VALUES (?, ?, ?, ?)')
      for (const figure of figures) insertFigure.run(figure.id, figure.paper_id, figure.workspace_path, ftsIndexedText([
        figure.figure_label ?? '', figure.section_title, figure.raw_caption, figure.vision_description ?? '', figure.nearby_text,
      ].filter(Boolean).join('\n')))
      db.prepare('UPDATE paperagent_fts_state SET status = \'ready\', error = NULL, updated_at = ? WHERE singleton = 1').run(new Date().toISOString())
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      const message = error instanceof Error ? error.message : String(error)
      db.prepare(`INSERT INTO paperagent_fts_state (singleton, status, error, updated_at) VALUES (1, 'failed', ?, ?)
        ON CONFLICT(singleton) DO UPDATE SET status = 'failed', error = excluded.error, updated_at = excluded.updated_at`)
        .run(message.slice(0, 1_000), new Date().toISOString())
      return false
    }
    return true
  } catch {
    return false
  }
}

function ensureFtsTableShape(db: DatabaseSync, table: string, expected: readonly string[]): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name?: unknown }>
  if (columns.length === 0 || expected.every(name => columns.some(column => column.name === name))) return
  db.exec(`DROP TABLE IF EXISTS ${table}`)
}



function ftsIndexedText(content: string): string {
  const cjkBigrams = [...content.matchAll(/[\u3400-\u9fff]+/g)]
    .flatMap(match => {
      const run = match[0] ?? ''
      return [...Array(Math.max(0, run.length - 1))].map((_, index) => run.slice(index, index + 2))
    })
  return cjkBigrams.length === 0 ? content : `${content}\n${cjkBigrams.join(' ')}`
}
