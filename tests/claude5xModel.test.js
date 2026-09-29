const { isClaude5xModel } = require('../src/utils/claude5xModel')

describe('isClaude5xModel', () => {
  test('matches Claude 5.x family', () => {
    for (const model of [
      'claude-sonnet-5',
      'claude-sonnet-5-5',
      'claude-opus-5',
      'claude-opus-5-5',
      'claude-opus-5-5-fast',
      'claude-opus-5-fast',
      'claude-fable-5',
      'claude-fable-5-1',
      'claude-fable-5.1',
      'claude-haiku-5'
    ]) {
      expect(isClaude5xModel(model)).toBe(true)
    }
  })

  test('does not match Claude 4.x', () => {
    for (const model of [
      'claude-sonnet-4-5-20250929',
      'claude-sonnet-4-6',
      'claude-opus-4-6',
      'claude-opus-4-5-20251101',
      'claude-haiku-4-5-20251001',
      'gpt-5.1'
    ]) {
      expect(isClaude5xModel(model)).toBe(false)
    }
  })
})
