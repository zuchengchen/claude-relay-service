/**
 * 模拟真实 Claude Code 的 prompt cache 口径（非测量结果）。
 *
 * 同一 API Key + 模型 + system/tools 前缀，5 分钟内：
 * - 首轮（冷）：约 90% cache_creation，10% 未缓存 input，0 命中
 * - 之后（热）：约 90% cache_read，8% 新写 cache_creation，2% 未缓存 input
 *
 * 总量不变。TTL 对齐 Anthropic ephemeral 5 分钟。
 */

const crypto = require('crypto')

const CLAUDE_CACHE_READ_RATIO = 0.9
const HOT_TTL_MS = 5 * 60 * 1000
const COLD_CREATION_RATIO = 0.9
const HOT_READ_RATIO = 0.9
const HOT_CREATION_RATIO = 0.08

const cacheStates = new Map()

function appliesTo(model) {
  return typeof model === 'string' && model.trim().toLowerCase().startsWith('claude-')
}

function toNonNegInt(value) {
  const num = Number(value)
  if (!Number.isFinite(num) || num <= 0) {
    return 0
  }
  return Math.floor(num)
}

function allocate(total, readRatio, creationRatio) {
  if (total <= 0) {
    return { input: 0, creation: 0, read: 0 }
  }

  let read = Math.round(total * readRatio)
  let creation = Math.round(total * creationRatio)
  if (read + creation > total) {
    creation = Math.max(0, total - read)
  }
  return {
    input: total - read - creation,
    creation,
    read
  }
}

function splitForMode(total, mode) {
  if (mode === 'hot') {
    return allocate(total, HOT_READ_RATIO, HOT_CREATION_RATIO)
  }
  return allocate(total, 0, COLD_CREATION_RATIO)
}

function prefixFingerprint(requestBody) {
  const body = requestBody && typeof requestBody === 'object' ? requestBody : {}
  const system = typeof body.system === 'string' ? body.system : JSON.stringify(body.system || '')
  const tools = body.tools ? JSON.stringify(body.tools) : ''
  return crypto
    .createHash('sha256')
    .update(system)
    .update('\n')
    .update(tools)
    .digest('hex')
    .slice(0, 16)
}

function buildCacheKey({ apiKeyId, model, requestBody } = {}) {
  const keyId = apiKeyId || 'nokey'
  const modelId = String(model || 'unknown')
    .trim()
    .toLowerCase()
  return `${keyId}:${modelId}:${prefixFingerprint(requestBody)}`
}

function consumeCacheState(cacheKey) {
  if (!cacheKey) {
    return 'cold'
  }

  const now = Date.now()
  if (cacheStates.size > 4000) {
    for (const [key, expiresAt] of cacheStates) {
      if (expiresAt <= now) {
        cacheStates.delete(key)
      }
    }
  }

  const expiresAt = cacheStates.get(cacheKey)
  const hot = Boolean(expiresAt && expiresAt > now)
  cacheStates.set(cacheKey, now + HOT_TTL_MS)
  return hot ? 'hot' : 'cold'
}

function resetCacheStateForTests() {
  cacheStates.clear()
}

function promptTotal(usage) {
  return (
    toNonNegInt(usage.input_tokens) +
    toNonNegInt(usage.cache_creation_input_tokens) +
    toNonNegInt(usage.cache_read_input_tokens)
  )
}

function writeAnthropicUsage(usage, rewritten) {
  usage.input_tokens = rewritten.input
  usage.cache_creation_input_tokens = rewritten.creation
  usage.cache_read_input_tokens = rewritten.read
  if (
    rewritten.creation > 0 ||
    (usage.cache_creation && typeof usage.cache_creation === 'object')
  ) {
    usage.cache_creation = {
      ephemeral_5m_input_tokens: rewritten.creation,
      ephemeral_1h_input_tokens: 0
    }
  }
  return usage
}

function applyToAnthropicUsage(model, usage, cacheMode = 'cold') {
  if (!appliesTo(model) || !usage || typeof usage !== 'object') {
    return usage
  }

  const total = promptTotal(usage)
  if (total <= 0) {
    return usage
  }

  return writeAnthropicUsage(usage, splitForMode(total, cacheMode))
}

function applyToOpenAIUsage(model, usage, cacheMode = 'cold') {
  if (!appliesTo(model) || !usage || typeof usage !== 'object') {
    return usage
  }

  const prompt = toNonNegInt(usage.prompt_tokens ?? usage.input_tokens)
  const cached = toNonNegInt(
    usage.prompt_tokens_details?.cached_tokens ??
      usage.input_tokens_details?.cached_tokens ??
      usage.cache_read_input_tokens
  )
  const creation = toNonNegInt(
    usage.cache_creation_input_tokens ?? usage.input_tokens_details?.cache_creation_input_tokens
  )
  const uncached = Math.max(0, prompt - cached - creation)
  const total = uncached + creation + cached
  if (total <= 0) {
    return usage
  }

  const rewritten = splitForMode(total, cacheMode)
  const nextTotal = rewritten.input + rewritten.creation + rewritten.read
  if (usage.prompt_tokens !== undefined) {
    usage.prompt_tokens = nextTotal
  }
  if (usage.input_tokens !== undefined) {
    usage.input_tokens = rewritten.input
  }
  usage.cache_creation_input_tokens = rewritten.creation
  usage.cache_read_input_tokens = rewritten.read
  if (usage.prompt_tokens_details && typeof usage.prompt_tokens_details === 'object') {
    usage.prompt_tokens_details.cached_tokens = rewritten.read
  } else if (rewritten.read > 0) {
    usage.prompt_tokens_details = { cached_tokens: rewritten.read }
  }
  if (usage.input_tokens_details && typeof usage.input_tokens_details === 'object') {
    usage.input_tokens_details.cached_tokens = rewritten.read
  }

  return usage
}

function rewriteSseLine(line, model, endpointType, cacheMode = 'cold') {
  if (typeof line !== 'string' || !appliesTo(model)) {
    return line
  }

  const dataPrefix = line.startsWith('data: ')
    ? 'data: '
    : line.startsWith('data:')
      ? 'data:'
      : null
  if (!dataPrefix) {
    return line
  }

  const jsonStr = line.slice(dataPrefix.length).trim()
  if (!jsonStr || jsonStr === '[DONE]') {
    return line
  }

  let data
  try {
    data = JSON.parse(jsonStr)
  } catch {
    return line
  }

  if (!data || typeof data !== 'object') {
    return line
  }

  if (endpointType === 'anthropic') {
    if (data.type === 'message_start' && data.message && data.message.usage) {
      applyToAnthropicUsage(model, data.message.usage, cacheMode)
      return `${dataPrefix}${JSON.stringify(data)}`
    }
    if (data.type === 'message_delta' && data.usage) {
      applyToAnthropicUsage(model, data.usage, cacheMode)
      return `${dataPrefix}${JSON.stringify(data)}`
    }
    return line
  }

  if (data.usage) {
    applyToOpenAIUsage(model, data.usage, cacheMode)
    return `${dataPrefix}${JSON.stringify(data)}`
  }
  if (data.response && data.response.usage) {
    applyToOpenAIUsage(model, data.response.usage, cacheMode)
    return `${dataPrefix}${JSON.stringify(data)}`
  }

  return line
}

function rewriteSseChunk(chunkStr, model, endpointType, carry, cacheMode = 'cold') {
  const combined = `${carry || ''}${chunkStr || ''}`
  const parts = combined.split('\n')
  const nextCarry = parts.pop()
  const rewritten = parts
    .map((line) => rewriteSseLine(line, model, endpointType, cacheMode))
    .join('\n')
  const output = parts.length > 0 ? `${rewritten}\n` : ''
  return { output, carry: nextCarry || '' }
}

module.exports = {
  CLAUDE_CACHE_READ_RATIO,
  HOT_TTL_MS,
  appliesTo,
  splitForMode,
  buildCacheKey,
  consumeCacheState,
  resetCacheStateForTests,
  applyToAnthropicUsage,
  applyToOpenAIUsage,
  rewriteSseLine,
  rewriteSseChunk
}
