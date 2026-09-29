const {
  appliesTo,
  splitForMode,
  consumeCacheState,
  resetCacheStateForTests,
  applyToAnthropicUsage,
  rewriteSseLine
} = require('../src/utils/fixedClaudeCacheRatio')

describe('fixedClaudeCacheRatio', () => {
  beforeEach(() => {
    resetCacheStateForTests()
  })

  test('only claude models apply', () => {
    expect(appliesTo('claude-sonnet-5-5')).toBe(true)
    expect(appliesTo('claude-opus-4-6-thinking')).toBe(true)
    expect(appliesTo('gpt-5.6-luna')).toBe(false)
  })

  test('cold start is mostly cache write', () => {
    expect(splitForMode(1000, 'cold')).toEqual({ input: 100, creation: 900, read: 0 })
  })

  test('hot turn is mostly cache read plus a small write', () => {
    expect(splitForMode(1000, 'hot')).toEqual({ input: 20, creation: 80, read: 900 })
  })

  test('allocations keep total', () => {
    for (const total of [1, 11, 38, 1000]) {
      for (const mode of ['cold', 'hot']) {
        const once = splitForMode(total, mode)
        expect(once.input + once.creation + once.read).toBe(total)
      }
    }
  })

  test('same prefix is cold then hot', () => {
    expect(consumeCacheState('k1')).toBe('cold')
    expect(consumeCacheState('k1')).toBe('hot')
    expect(consumeCacheState('k2')).toBe('cold')
  })

  test('rewrites anthropic usage for cold and hot', () => {
    const cold = {
      input_tokens: 1000,
      output_tokens: 12,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0
    }
    applyToAnthropicUsage('claude-sonnet-5-5', cold, 'cold')
    expect(cold.input_tokens).toBe(100)
    expect(cold.cache_creation_input_tokens).toBe(900)
    expect(cold.cache_read_input_tokens).toBe(0)
    expect(cold.output_tokens).toBe(12)

    const hot = {
      input_tokens: 1000,
      output_tokens: 12,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0
    }
    applyToAnthropicUsage('claude-sonnet-5-5', hot, 'hot')
    expect(hot.input_tokens).toBe(20)
    expect(hot.cache_creation_input_tokens).toBe(80)
    expect(hot.cache_read_input_tokens).toBe(900)
  })

  test('rewrites message_start sse line with cache mode', () => {
    const line =
      'data: {"type":"message_start","message":{"usage":{"input_tokens":1000,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":0}}}'
    const rewritten = rewriteSseLine(line, 'claude-opus-4-6', 'anthropic', 'hot')
    const data = JSON.parse(rewritten.slice(6))
    expect(data.message.usage.cache_read_input_tokens).toBe(900)
    expect(data.message.usage.cache_creation_input_tokens).toBe(80)
  })
})
