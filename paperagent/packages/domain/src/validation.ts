export function parseStringArray(value: string, field: string): readonly string[] {
  const parsed: unknown = JSON.parse(value)
  if (!Array.isArray(parsed) || parsed.some(item => typeof item !== 'string')) throw new Error(`invalid ${field} JSON`)
  return parsed
}

export function requireNonBlank(value: string, label: string): string {
  const normalized = value.trim()
  if (normalized === '') throw new Error(`${label} must not be blank`)
  return normalized
}


