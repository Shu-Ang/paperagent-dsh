import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizePaperReference, resolvePaperReference } from '../packages/tools/src/import/adapter-registry.ts'

test('normalizes arXiv, DOI, direct URL, and title references without discovery side effects', () => {
  assert.deepEqual(normalizePaperReference(' https://arxiv.org/abs/2401.01234 '), { kind: 'arxiv', value: 'https://arxiv.org/abs/2401.01234' })
  assert.deepEqual(normalizePaperReference('doi:10.1000/example.1'), { kind: 'doi', value: '10.1000/example.1' })
  assert.deepEqual(normalizePaperReference('https://repository.example.edu/download?id=42'), { kind: 'url', value: 'https://repository.example.edu/download?id=42' })
  assert.deepEqual(normalizePaperReference('Attention Is All You Need'), { kind: 'title', value: 'Attention Is All You Need' })
})

test('resolves official arXiv metadata into one import candidate', async () => {
  await withMockFetch(async url => {
    assert.match(url, /export\.arxiv\.org\/api\/query/)
    return new Response(`<?xml version="1.0"?><feed><entry><title>Example Paper</title><published>2024-01-02T00:00:00Z</published><summary>  Abstract text. </summary><author><name>Ada Lovelace</name></author><category term="cs.AI"/><arxiv:doi>10.1000/example</arxiv:doi></entry></feed>`, { status: 200 })
  }, async () => {
    const [candidate] = await resolvePaperReference('https://arxiv.org/abs/2401.01234')
    assert.equal(candidate?.title, 'Example Paper')
    assert.equal(candidate?.pdfUrl, 'https://arxiv.org/pdf/2401.01234.pdf')
    assert.match(candidate?.bibtex ?? '', /archivePrefix/)
  })
})

test('resolves DOI metadata and a verified OpenAlex public PDF candidate', async () => {
  await withMockFetch(async url => {
    if (url.startsWith('https://api.crossref.org/works/')) {
      return Response.json({ message: {
        title: ['DOI Paper'], DOI: '10.1000/example', author: [{ given: 'Ada', family: 'Lovelace' }],
        issued: { 'date-parts': [[2025]] }, 'container-title': ['Journal'], URL: 'https://doi.org/10.1000/example',
      } })
    }
    if (url.startsWith('https://api.openalex.org/works/')) {
      return Response.json({ best_oa_location: { pdf_url: 'https://open.example.org/paper.pdf' } })
    }
    throw new Error(`unexpected fetch URL: ${url}`)
  }, async () => {
    const [candidate] = await resolvePaperReference('https://doi.org/10.1000/example')
    assert.equal(candidate?.title, 'DOI Paper')
    assert.equal(candidate?.pdfUrl, 'https://open.example.org/paper.pdf')
    assert.equal(candidate?.doi, '10.1000/example')
    assert.match(candidate?.bibtex ?? '', /@article/)
  })
})

test('resolves stable OpenReview, ACL Anthology, and CVF public PDF routes', async () => {
  await withMockFetch(async url => {
    assert.equal(url, 'https://aclanthology.org/2024.acl-long.1.bib')
    return new Response('@inproceedings{sample, title={ACL Paper}, author={Ada Lovelace}, year={2024}, doi={10.1/acl}}', { status: 200 })
  }, async () => {
    const [openReview] = await resolvePaperReference('https://openreview.net/forum?id=abc123')
    assert.equal(openReview?.pdfUrl, 'https://openreview.net/pdf?id=abc123')
    const [acl] = await resolvePaperReference('https://aclanthology.org/2024.acl-long.1/')
    assert.equal(acl?.title, 'ACL Paper')
    assert.equal(acl?.bibtex !== null, true)
    const [cvf] = await resolvePaperReference('https://openaccess.thecvf.com/content/CVPR2024/papers/Example_CVPR_2024_paper.pdf')
    assert.equal(cvf?.source, 'CVF Open Access')
  })
})

async function withMockFetch<T>(
  mock: (url: string) => Promise<Response>,
  run: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch
  globalThis.fetch = (input: RequestInfo | URL) => mock(typeof input === 'string' ? input : input.toString())
  try { return await run() } finally { globalThis.fetch = original }
}
