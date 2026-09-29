/**
 * Factory 的 /o/v1/chat/completions 与 /o/v1/responses 不接受 Claude 的 x-api-provider。
 * Claude 模型在 comm/openai 入口改走 /a/v1/messages，再把结果转回 OpenAI 形态。
 */

function isClaudeModel(model) {
  return typeof model === 'string' && model.trim().toLowerCase().startsWith('claude-')
}

function toAnthropicFromChatCompletions(body = {}) {
  const systems = []
  const messages = []
  for (const msg of Array.isArray(body.messages) ? body.messages : []) {
    if (!msg || !msg.role) {
      continue
    }
    if (msg.role === 'system') {
      systems.push(typeof msg.content === 'string' ? msg.content : flattenText(msg.content))
      continue
    }
    if (msg.role === 'user' || msg.role === 'assistant') {
      messages.push({
        role: msg.role,
        content: msg.content
      })
    }
  }

  const maxTokens = body.max_tokens || body.max_completion_tokens || 4096
  const out = {
    model: body.model,
    messages,
    max_tokens: maxTokens,
    stream: Boolean(body.stream)
  }
  if (systems.length > 0) {
    out.system = systems.join('\n')
  }
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    out.tools = body.tools
      .filter((tool) => tool && tool.type === 'function' && tool.function)
      .map((tool) => ({
        name: tool.function.name,
        description: tool.function.description || '',
        input_schema: tool.function.parameters || { type: 'object', properties: {} }
      }))
  }
  if (body.thinking) {
    out.thinking = body.thinking
  } else if (body.reasoning_effort) {
    out.thinking = thinkingFromEffort(body.reasoning_effort)
    out.output_config = { effort: String(body.reasoning_effort).toLowerCase() }
  }
  return out
}

function toAnthropicFromResponses(body = {}) {
  const input = body.input
  let userText = ''
  if (typeof input === 'string') {
    userText = input
  } else if (Array.isArray(input)) {
    userText = input
      .map((item) => {
        if (typeof item === 'string') {
          return item
        }
        if (item && item.content) {
          return flattenText(item.content)
        }
        return ''
      })
      .filter(Boolean)
      .join('\n')
  } else {
    userText = flattenText(input)
  }

  const out = {
    model: body.model,
    messages: [{ role: 'user', content: userText || 'hi' }],
    max_tokens: body.max_output_tokens || body.max_tokens || 4096,
    stream: Boolean(body.stream)
  }
  if (body.instructions) {
    out.system = body.instructions
  }
  if (body.thinking) {
    out.thinking = body.thinking
  } else if (body.reasoning && body.reasoning.effort) {
    out.thinking = thinkingFromEffort(body.reasoning.effort)
  }
  return out
}

function thinkingFromEffort(effort) {
  const value = String(effort || '').toLowerCase()
  if (value === 'none' || value === 'off') {
    return { type: 'disabled' }
  }
  return { type: 'adaptive' }
}

function flattenText(content) {
  if (typeof content === 'string') {
    return content
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') {
          return part
        }
        if (part && part.type === 'text') {
          return part.text || ''
        }
        if (part && part.text) {
          return part.text
        }
        return ''
      })
      .join('')
  }
  if (content && typeof content === 'object' && content.text) {
    return content.text
  }
  return ''
}

function collectAnthropicParts(content = []) {
  const texts = []
  const thinkings = []
  const toolCalls = []
  for (const block of Array.isArray(content) ? content : []) {
    if (!block) {
      continue
    }
    if (block.type === 'text' && block.text) {
      texts.push(block.text)
    }
    if (block.type === 'thinking' && block.thinking) {
      thinkings.push(block.thinking)
    }
    if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input || {})
        }
      })
    }
  }
  return { texts, thinkings, toolCalls }
}

function usageFromAnthropic(usage = {}) {
  const prompt =
    (usage.input_tokens || 0) +
    (usage.cache_creation_input_tokens || 0) +
    (usage.cache_read_input_tokens || 0)
  const completion = usage.output_tokens || 0
  const cached = usage.cache_read_input_tokens || 0
  const out = {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion
  }
  if (cached > 0) {
    out.prompt_tokens_details = { cached_tokens: cached }
  }
  return out
}

function anthropicToChatCompletions(data = {}, model) {
  const { texts, thinkings, toolCalls } = collectAnthropicParts(data.content)
  const message = {
    role: 'assistant',
    content: texts.join('') || null
  }
  if (thinkings.length > 0) {
    message.reasoning_content = thinkings.join('\n')
  }
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls
    if (!message.content) {
      message.content = null
    }
  }
  return {
    id: data.id || `msg_${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model || data.model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: data.stop_reason === 'tool_use' ? 'tool_calls' : 'stop'
      }
    ],
    usage: usageFromAnthropic(data.usage)
  }
}

function anthropicToResponses(data = {}, model) {
  const { texts, thinkings, toolCalls } = collectAnthropicParts(data.content)
  const output = []
  if (thinkings.length > 0) {
    output.push({
      type: 'reasoning',
      id: `rs_${Date.now()}`,
      summary: thinkings.map((text) => ({ type: 'summary_text', text }))
    })
  }
  output.push({
    type: 'message',
    id: `msg_${Date.now()}`,
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text: texts.join('') }]
  })
  for (const call of toolCalls) {
    output.push({
      type: 'function_call',
      call_id: call.id,
      name: call.function.name,
      arguments: call.function.arguments
    })
  }
  const usage = data.usage || {}
  return {
    id: data.id || `resp_${Date.now()}`,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    model: model || data.model,
    status: 'completed',
    output,
    usage: {
      input_tokens:
        (usage.input_tokens || 0) +
        (usage.cache_creation_input_tokens || 0) +
        (usage.cache_read_input_tokens || 0),
      output_tokens: usage.output_tokens || 0,
      total_tokens:
        (usage.input_tokens || 0) +
        (usage.cache_creation_input_tokens || 0) +
        (usage.cache_read_input_tokens || 0) +
        (usage.output_tokens || 0)
    }
  }
}

function createSseTranslator(format, model) {
  const state = {
    id: '',
    model,
    created: Math.floor(Date.now() / 1000),
    seq: 0
  }

  const emitChat = (delta, finishReason = null) => {
    const chunk = {
      id: state.id || `msg_${state.created}`,
      object: 'chat.completion.chunk',
      created: state.created,
      model: state.model,
      choices: [
        {
          index: 0,
          delta,
          finish_reason: finishReason
        }
      ]
    }
    return `data: ${JSON.stringify(chunk)}\n\n`
  }

  const emitResponses = (type, extra) => {
    const evt = { type, sequence_number: state.seq++, ...extra }
    return `event: ${type}\ndata: ${JSON.stringify(evt)}\n\n`
  }

  return {
    translateLine(line) {
      if (typeof line !== 'string' || !line.startsWith('data:')) {
        return ''
      }
      const jsonStr = line.replace(/^data:\s?/, '').trim()
      if (!jsonStr || jsonStr === '[DONE]') {
        return format === 'chat_completions' ? 'data: [DONE]\n\n' : ''
      }
      let data
      try {
        data = JSON.parse(jsonStr)
      } catch {
        return ''
      }

      if (format === 'chat_completions') {
        return translateChatEvent(data, state, emitChat)
      }
      return translateResponsesEvent(data, state, emitResponses)
    }
  }
}

function translateChatEvent(data, state, emitChat) {
  if (data.type === 'message_start' && data.message) {
    state.id = data.message.id || state.id
    state.model = data.message.model || state.model
    return emitChat({ role: 'assistant' })
  }
  if (data.type === 'content_block_delta' && data.delta) {
    if (data.delta.type === 'text_delta' && data.delta.text) {
      return emitChat({ content: data.delta.text })
    }
    if (data.delta.type === 'thinking_delta' && data.delta.thinking) {
      return emitChat({ reasoning_content: data.delta.thinking })
    }
  }
  if (data.type === 'message_delta' && data.delta && data.delta.stop_reason) {
    const reason = data.delta.stop_reason === 'tool_use' ? 'tool_calls' : 'stop'
    return emitChat({}, reason)
  }
  if (data.type === 'message_stop') {
    return 'data: [DONE]\n\n'
  }
  return ''
}

function translateResponsesEvent(data, state, emitResponses) {
  if (data.type === 'message_start' && data.message) {
    state.id = data.message.id || state.id
    return emitResponses('response.created', {
      response: {
        id: state.id,
        object: 'response',
        created_at: state.created,
        model: state.model,
        status: 'in_progress',
        output: []
      }
    })
  }
  if (data.type === 'content_block_delta' && data.delta) {
    if (data.delta.type === 'text_delta' && data.delta.text) {
      return emitResponses('response.output_text.delta', { delta: data.delta.text })
    }
    if (data.delta.type === 'thinking_delta' && data.delta.thinking) {
      return emitResponses('response.reasoning_summary_text.delta', { delta: data.delta.thinking })
    }
  }
  if (data.type === 'message_stop') {
    return emitResponses('response.completed', {
      response: {
        id: state.id,
        object: 'response',
        status: 'completed'
      }
    })
  }
  return ''
}

module.exports = {
  isClaudeModel,
  toAnthropicFromChatCompletions,
  toAnthropicFromResponses,
  anthropicToChatCompletions,
  anthropicToResponses,
  createSseTranslator
}
