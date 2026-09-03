/** DeepSeek-only, non-streaming academic-figure description client. */

export const VISION_MODEL = 'deepseek-v4-flash-vision-exp'
export const VISION_PROMPT_VERSION = 'paperagent-figure-v1'

export interface FigureDescription {
  readonly figureType: string
  readonly summary: string
  readonly ocrText: readonly string[]
  readonly axesAndLegend: string
  readonly keyFindings: readonly string[]
  readonly uncertainties: readonly string[]
}

export interface DescribeFigureInput {
  readonly image: Uint8Array
  readonly mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  readonly rawCaption: string
  readonly sectionTitle: string
  readonly nearbyText: string
  readonly signal?: AbortSignal
}

export interface DeepSeekVisionClientOptions {
  readonly apiBaseUrl?: string
  readonly model?: string
  readonly resolveApiKey: () => Promise<string>
  readonly fetch?: typeof fetch
}

export class DeepSeekVisionClient {
  private readonly apiBaseUrl: string
  private readonly model: string
  private readonly fetchImpl: typeof fetch

  constructor(private readonly options: DeepSeekVisionClientOptions) {
    this.apiBaseUrl = (options.apiBaseUrl ?? 'https://api.deepseek.com').replace(/\/+$/, '')
    this.model = options.model ?? VISION_MODEL
    this.fetchImpl = options.fetch ?? fetch
  }

  async describe(input: DescribeFigureInput): Promise<FigureDescription> {
    if (input.image.byteLength === 0) throw new Error('figure image is empty')
    const apiKey = (await this.options.resolveApiKey()).trim()
    if (apiKey === '') throw new Error('DeepSeek API key is missing')
    const response = await this.fetchImpl(`${this.apiBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      body: JSON.stringify({
        model: this.model,
        stream: false,
        thinking: { type: 'disabled' },
        temperature: 0.2,
        max_tokens: 1200,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'You analyze academic-paper figures. Return only a valid JSON object with figureType, summary, ocrText, axesAndLegend, keyFindings, and uncertainties. Do not invent claims not visible in the image or supplied context.' },
          {
            role: 'user',
            content: [
              { type: 'text', text: promptFor(input) },
              { type: 'image_url', image_url: { url: `data:${input.mimeType};base64,${Buffer.from(input.image).toString('base64')}`, detail: 'high' } },
            ],
          },
        ],
      }),
    })
    if (!response.ok) throw new Error(`DeepSeek Vision request failed with HTTP ${response.status}`)
    const payload = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> }
    const content = payload.choices?.[0]?.message?.content
    if (typeof content !== 'string') throw new Error('DeepSeek Vision response is missing message content')
    return validateDescription(content)
  }
}

function promptFor(input: DescribeFigureInput): string {
  return [
    'Analyze this one academic-paper figure for retrieval and reading assistance.',
    `Original caption: ${truncate(input.rawCaption, 2_000) || '(none)'}`,
    `Section: ${truncate(input.sectionTitle, 300) || 'Document'}`,
    `Nearby paper text: ${truncate(input.nearbyText, 3_000) || '(none)'}`,
    'The response must be JSON. Keep uncertainty explicit; do not state unobservable numerical values as facts.',
  ].join('\n')
}

function validateDescription(value: string): FigureDescription {
  let parsed: unknown
  try { parsed = JSON.parse(value) } catch { throw new Error('DeepSeek Vision returned invalid JSON') }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('DeepSeek Vision returned a non-object description')
  const record = parsed as Record<string, unknown>
  const text = (key: string): string => typeof record[key] === 'string' ? record[key].trim() : ''
  const strings = (key: string): readonly string[] => Array.isArray(record[key]) ? record[key].filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(Boolean) : []
  const description: FigureDescription = {
    figureType: text('figureType'), summary: text('summary'), ocrText: strings('ocrText'), axesAndLegend: text('axesAndLegend'), keyFindings: strings('keyFindings'), uncertainties: strings('uncertainties'),
  }
  if (description.figureType === '' || description.summary === '') throw new Error('DeepSeek Vision description is missing figureType or summary')
  return description
}

function truncate(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum)}…`
}
