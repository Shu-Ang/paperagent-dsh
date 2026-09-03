import assert from 'node:assert/strict'
import test from 'node:test'
import { DeepSeekVisionClient, VISION_MODEL } from '../packages/vision-deepseek/src/index.ts'

test('DeepSeek vision client sends a bounded image data URL and validates structured JSON', async () => {
  let request: RequestInit | undefined
  const client = new DeepSeekVisionClient({
    resolveApiKey: async () => 'unit-test-key',
    fetch: async (_url, init) => {
      request = init
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        figureType: 'line chart', summary: 'A trend line.', ocrText: ['Epoch'], axesAndLegend: 'x: epoch', keyFindings: ['rises'], uncertainties: ['low resolution'],
      }) } }] }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })

  const result = await client.describe({
    image: new Uint8Array([137, 80, 78, 71]), mimeType: 'image/png', rawCaption: 'Trend', sectionTitle: 'Results', nearbyText: 'Experiment context.',
  })

  assert.equal(result.figureType, 'line chart')
  const payload = JSON.parse(String(request?.body)) as { model: string; messages: Array<{ content: unknown }> }
  assert.equal(payload.model, VISION_MODEL)
  const content = payload.messages[1]?.content as Array<{ type: string; image_url?: { url: string } }>
  assert.match(content[1]?.image_url?.url ?? '', /^data:image\/png;base64,/)
  assert.equal(String(request?.headers && (request.headers as Record<string, string>).Authorization), 'Bearer unit-test-key')
})

test('DeepSeek vision client refuses malformed model output', async () => {
  const client = new DeepSeekVisionClient({
    resolveApiKey: async () => 'unit-test-key',
    fetch: async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"summary":"missing type"}' } }] }), { status: 200 }),
  })
  await assert.rejects(
    client.describe({ image: new Uint8Array([1]), mimeType: 'image/png', rawCaption: '', sectionTitle: 'Document', nearbyText: '' }),
    /missing figureType or summary/,
  )
})
