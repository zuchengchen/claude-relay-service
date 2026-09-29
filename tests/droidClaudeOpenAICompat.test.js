const {
  isClaudeModel,
  toAnthropicFromChatCompletions,
  anthropicToChatCompletions
} = require('../src/utils/droidClaudeOpenAICompat')

describe('droidClaudeOpenAICompat', () => {
  test('detects claude models', () => {
    expect(isClaudeModel('claude-sonnet-5-5')).toBe(true)
    expect(isClaudeModel('gpt-5.1')).toBe(false)
  })

  test('converts chat completions to anthropic', () => {
    const out = toAnthropicFromChatCompletions({
      model: 'claude-sonnet-5-5',
      max_tokens: 32,
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'hi' }
      ]
    })
    expect(out.system).toBe('be brief')
    expect(out.messages).toEqual([{ role: 'user', content: 'hi' }])
    expect(out.max_tokens).toBe(32)
  })

  test('copies thinking into reasoning_content', () => {
    const cc = anthropicToChatCompletions(
      {
        id: 'msg_1',
        model: 'claude-sonnet-5-5',
        stop_reason: 'end_turn',
        content: [
          { type: 'thinking', thinking: 'plan' },
          { type: 'text', text: '323' }
        ],
        usage: { input_tokens: 10, output_tokens: 2 }
      },
      'claude-sonnet-5-5'
    )
    expect(cc.choices[0].message.content).toBe('323')
    expect(cc.choices[0].message.reasoning_content).toBe('plan')
  })
})
