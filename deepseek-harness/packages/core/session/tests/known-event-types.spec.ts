import { describe, expect, it } from 'vitest'
import { decodeRegisteredSessionEventData, KNOWN_SESSION_EVENT_TYPES, registerKnownSessionEventType } from '@deepseek-ai/dsh-session'

describe('plugin session event registry', () => {
  it('registers namespaced event types and removes them on final dispose', () => {
    const type = 'fixture/plugin-event'
    const dispose = registerKnownSessionEventType(type)
    expect(KNOWN_SESSION_EVENT_TYPES.has(type)).toBe(true)
    dispose()
    expect(KNOWN_SESSION_EVENT_TYPES.has(type)).toBe(false)
  })

  it('keeps shared registrations until every plugin disposer runs', () => {
    const type = 'fixture/shared-event'
    const first = registerKnownSessionEventType(type)
    const second = registerKnownSessionEventType(type)
    first()
    expect(KNOWN_SESSION_EVENT_TYPES.has(type)).toBe(true)
    second()
    expect(KNOWN_SESSION_EVENT_TYPES.has(type)).toBe(false)
  })

  it('rejects event types without namespace/name syntax', () => {
    expect(() => registerKnownSessionEventType('fixture event')).toThrow(/namespace\/name/)
  })

  it('applies a registered decoder and removes it after the final disposer', () => {
    const decode = (value: unknown) => ({ normalized: value })
    const first = registerKnownSessionEventType('fixture/decoded', { decode })
    const second = registerKnownSessionEventType('fixture/decoded', { decode })
    expect(decodeRegisteredSessionEventData('fixture/decoded', 42)).toEqual({ normalized: 42 })
    first()
    expect(KNOWN_SESSION_EVENT_TYPES.has('fixture/decoded')).toBe(true)
    second()
    expect(KNOWN_SESSION_EVENT_TYPES.has('fixture/decoded')).toBe(false)
    expect(decodeRegisteredSessionEventData('fixture/decoded', 42)).toBe(42)
  })

  it('can retain a durable decoder after its plugin disposer runs', () => {
    const type = 'fixture/retained'
    const decode = (value: unknown) => ({ retained: value })
    const dispose = registerKnownSessionEventType(type, { decode, retainOnDispose: true })
    dispose()
    expect(KNOWN_SESSION_EVENT_TYPES.has(type)).toBe(true)
    expect(decodeRegisteredSessionEventData(type, 42)).toEqual({ retained: 42 })
  })

  it('rejects conflicting decoders for one event type', () => {
    const first = registerKnownSessionEventType('fixture/conflict', { decode: value => value })
    expect(() => registerKnownSessionEventType('fixture/conflict', { decode: value => String(value) })).toThrow(/different decoder/)
    first()
  })
})
