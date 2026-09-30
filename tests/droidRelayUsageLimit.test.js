// 转发层：Factory 402 额度用尽 → 429、全部用尽 → 429 + 重置头、成功后更新额度窗口
jest.mock('axios', () => jest.fn())
jest.mock('https', () => {
  const { EventEmitter } = require('events')
  const state = { respond: null }
  return {
    __state: state,
    request: jest.fn((options, callback) => {
      const req = new EventEmitter()
      req.destroyed = false
      req.destroy = jest.fn(() => {
        req.destroyed = true
      })
      req.end = jest.fn(() => {
        process.nextTick(() => {
          const { statusCode = 200, chunks = [] } = state.respond || {}
          const res = new EventEmitter()
          res.statusCode = statusCode
          res.complete = false
          callback(res)
          chunks.forEach((chunk) => res.emit('data', Buffer.from(chunk)))
          res.complete = true
          res.emit('end')
        })
      })
      return req
    })
  }
})
jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn(),
  api: jest.fn()
}))
jest.mock('../src/utils/proxyHelper', () => ({
  createProxyAgent: jest.fn(() => null),
  getProxyDescription: jest.fn(() => '')
}))
jest.mock('../src/services/scheduler/droidScheduler', () => {
  class DroidAccountsExhaustedError extends Error {
    constructor(resetAt, exclusions = []) {
      super('exhausted')
      this.code = 'DROID_ACCOUNTS_EXHAUSTED'
      this.resetAt = resetAt
      this.exclusions = exclusions
    }
  }
  return { selectAccount: jest.fn(), DroidAccountsExhaustedError }
})
jest.mock('../src/services/account/droidAccountService', () => ({
  getValidAccessToken: jest.fn(async () => 'access-token'),
  getDecryptedApiKeyEntries: jest.fn(async () => []),
  markApiKeyAsError: jest.fn(async () => ({ marked: true })),
  touchApiKeyUsage: jest.fn(async () => {}),
  updateAccount: jest.fn(async () => ({}))
}))
jest.mock('../src/services/apiKeyService', () => ({
  recordUsageWithDetails: jest.fn(async () => ({ realCost: 0.01, ratedCost: 0.01 }))
}))
jest.mock('../src/models/redis', () => ({
  getSessionAccountMapping: jest.fn(async () => null),
  setSessionAccountMapping: jest.fn(async () => 'OK'),
  extendSessionAccountMappingTTL: jest.fn(async () => 1),
  deleteSessionAccountMapping: jest.fn(async () => 1),
  incrementAccountUsage: jest.fn(async () => {})
}))
jest.mock('../src/utils/rateLimitHelper', () => ({
  updateRateLimitCounters: jest.fn(async () => ({ totalTokens: 0, totalCost: 0 }))
}))
jest.mock('../src/utils/runtimeAddon', () => ({
  emitSync: jest.fn((_event, payload) => payload)
}))
jest.mock('../src/utils/upstreamErrorHelper', () => ({
  markTempUnavailable: jest.fn(async () => ({ success: true })),
  recordErrorHistory: jest.fn(async () => {})
}))
jest.mock('../src/services/droidUsageLimitService', () => ({
  recordLimit: jest.fn(async (_id, limit) => ({ ...limit, source: '402' }))
}))
jest.mock('../src/services/droidUsageWindowService', () => ({
  onUsageLimit: jest.fn(async () => null),
  onRequestSucceeded: jest.fn(async () => ({}))
}))

const https = require('https')
const axios = require('axios')
const droidScheduler = require('../src/services/scheduler/droidScheduler')
const droidAccountService = require('../src/services/account/droidAccountService')
const redis = require('../src/models/redis')
const upstreamErrorHelper = require('../src/utils/upstreamErrorHelper')
const droidUsageLimitService = require('../src/services/droidUsageLimitService')
const droidUsageWindowService = require('../src/services/droidUsageWindowService')
const droidRelayService = require('../src/services/relay/droidRelayService')

const FIVE_HOUR_DETAIL =
  "You've reached your 5-hour standard usage limit (resets in 2h 35min).\nSwitch to Droid Core or enable Extra Usage to continue."
const FIVE_HOUR_BODY = {
  detail: FIVE_HOUR_DETAIL,
  status: 402,
  title: 'Payment Required',
  error: { detail: FIVE_HOUR_DETAIL, status: 402, title: 'Payment Required' }
}
const OAUTH_ACCOUNT = {
  id: 'acct-oauth',
  name: 'bb6',
  authenticationMethod: 'GoogleOAuth',
  endpointType: 'anthropic',
  disableAutoProtection: 'false'
}
const REQUEST_BODY = {
  model: 'claude-sonnet-4-5',
  max_tokens: 16,
  messages: [{ role: 'user', content: 'hi' }]
}

const makeClientResponse = () => {
  const handlers = {}
  const res = {
    headersSent: false,
    destroyed: false,
    writableEnded: false,
    statusCode: 200,
    status: jest.fn((code) => {
      res.statusCode = code
      return res
    }),
    json: jest.fn(() => {
      res.headersSent = true
      res.writableEnded = true
      return res
    }),
    setHeader: jest.fn(),
    write: jest.fn(),
    end: jest.fn(() => {
      res.writableEnded = true
    }),
    on: jest.fn((event, handler) => {
      handlers[event] = handler
    })
  }
  return res
}

const axiosError = (status, data) => {
  const error = new Error(`Request failed with status code ${status}`)
  error.response = { status, data, headers: {} }
  return error
}

const relay = (body, clientResponse = makeClientResponse(), options = {}) =>
  droidRelayService.relayRequest(
    body,
    { id: 'key-1', name: 'sub2api' },
    { headers: {} },
    clientResponse,
    {},
    { endpointType: 'anthropic', sessionHash: 'session-1', ...options }
  )

beforeEach(() => {
  jest.clearAllMocks()
  droidScheduler.selectAccount.mockResolvedValue(OAUTH_ACCOUNT)
  https.__state.respond = null
})

describe('non-stream 402', () => {
  it('turns a parseable 402 into 429 usage_limit_reached and records the limit', async () => {
    axios.mockRejectedValueOnce(axiosError(402, FIVE_HOUR_BODY))

    const result = await relay(REQUEST_BODY)

    expect(result.statusCode).toBe(429)
    expect(result.headers).toEqual({ 'Content-Type': 'application/json' })
    expect(JSON.parse(result.body)).toEqual({
      error: {
        message: FIVE_HOUR_DETAIL,
        type: 'rate_limit_error',
        code: 'usage_limit_reached'
      }
    })
    expect(droidUsageLimitService.recordLimit).toHaveBeenCalledWith(
      OAUTH_ACCOUNT.id,
      expect.objectContaining({ window: 'fiveHour', detail: FIVE_HOUR_DETAIL })
    )
    expect(droidUsageWindowService.onUsageLimit).toHaveBeenCalledWith(
      OAUTH_ACCOUNT,
      expect.objectContaining({ window: 'fiveHour' })
    )
    expect(upstreamErrorHelper.markTempUnavailable).not.toHaveBeenCalled()
    expect(upstreamErrorHelper.recordErrorHistory).toHaveBeenCalledWith(
      OAUTH_ACCOUNT.id,
      'droid',
      402,
      'usage_limit',
      expect.objectContaining({ window: 'fiveHour' })
    )
    expect(redis.deleteSessionAccountMapping).toHaveBeenCalledWith(
      'droid:anthropic:key-1:session-1'
    )
  })

  it('falls back to the short cooldown when the limit cannot be stored', async () => {
    axios.mockRejectedValueOnce(axiosError(402, FIVE_HOUR_BODY))
    droidUsageLimitService.recordLimit.mockResolvedValueOnce(null)

    const result = await relay(REQUEST_BODY)

    expect(result.statusCode).toBe(429)
    expect(upstreamErrorHelper.markTempUnavailable).toHaveBeenCalledWith(
      OAUTH_ACCOUNT.id,
      'droid',
      402
    )
  })

  it('keeps 402 insufficient_quota for bodies that are not a usage limit', async () => {
    axios.mockRejectedValueOnce(
      axiosError(402, { detail: 'Payment required: update billing', status: 402 })
    )

    const result = await relay(REQUEST_BODY)

    expect(result.statusCode).toBe(402)
    expect(JSON.parse(result.body).error).toEqual(
      expect.objectContaining({ type: 'insufficient_quota', code: 'insufficient_quota' })
    )
    expect(droidUsageLimitService.recordLimit).not.toHaveBeenCalled()
    expect(upstreamErrorHelper.markTempUnavailable).toHaveBeenCalledWith(
      OAUTH_ACCOUNT.id,
      'droid',
      402
    )
  })

  it('returns 429 for api_key accounts without writing a limit record', async () => {
    const apiKeyAccount = { ...OAUTH_ACCOUNT, id: 'acct-key', authenticationMethod: 'api_key' }
    droidScheduler.selectAccount.mockResolvedValueOnce(apiKeyAccount)
    droidAccountService.getDecryptedApiKeyEntries.mockResolvedValue([
      { id: 'k1', key: 'fk-1', status: 'active' },
      { id: 'k2', key: 'fk-2', status: 'active' }
    ])
    axios.mockRejectedValueOnce(axiosError(402, FIVE_HOUR_BODY))

    const result = await relay(REQUEST_BODY)

    expect(result.statusCode).toBe(429)
    expect(JSON.parse(result.body).error.code).toBe('usage_limit_reached')
    expect(droidAccountService.markApiKeyAsError).toHaveBeenCalled()
    expect(droidUsageLimitService.recordLimit).not.toHaveBeenCalled()
  })

  it('notifies the window service after a successful response with usage', async () => {
    axios.mockResolvedValueOnce({
      status: 200,
      data: {
        id: 'msg_1',
        type: 'message',
        content: [{ type: 'text', text: 'hello' }],
        usage: { input_tokens: 1200, output_tokens: 30 }
      }
    })

    const result = await relay(REQUEST_BODY)

    expect(result.statusCode).toBe(200)
    expect(droidUsageWindowService.onRequestSucceeded).toHaveBeenCalledWith(
      OAUTH_ACCOUNT,
      expect.any(Number)
    )
  })
})

describe('stream 402', () => {
  it('responds 429 usage_limit_reached synchronously and records the limit', async () => {
    https.__state.respond = { statusCode: 402, chunks: [JSON.stringify(FIVE_HOUR_BODY)] }
    const clientResponse = makeClientResponse()

    const result = await relay({ ...REQUEST_BODY, stream: true }, clientResponse)

    expect(result).toEqual({ statusCode: 429, streaming: true })
    expect(clientResponse.status).toHaveBeenCalledWith(429)
    expect(clientResponse.json).toHaveBeenCalledWith({
      error: {
        message: FIVE_HOUR_DETAIL,
        type: 'rate_limit_error',
        code: 'usage_limit_reached'
      }
    })
    await new Promise((resolve) => setImmediate(resolve))
    expect(droidUsageLimitService.recordLimit).toHaveBeenCalledWith(
      OAUTH_ACCOUNT.id,
      expect.objectContaining({ window: 'fiveHour' })
    )
    expect(upstreamErrorHelper.markTempUnavailable).not.toHaveBeenCalled()
  })

  it('keeps the original 402 for unparseable stream bodies', async () => {
    https.__state.respond = { statusCode: 402, chunks: ['{"detail":"Payment required"}'] }
    const clientResponse = makeClientResponse()

    const result = await relay({ ...REQUEST_BODY, stream: true }, clientResponse)

    expect(result).toEqual({ statusCode: 402, streaming: true })
    expect(clientResponse.status).toHaveBeenCalledWith(402)
    expect(clientResponse.json.mock.calls[0][0].error.code).toBe('insufficient_quota')
  })

  it('notifies the window service when a stream completes with usage', async () => {
    https.__state.respond = {
      statusCode: 200,
      chunks: [
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":900,"output_tokens":1}}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":42}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n'
      ]
    }

    const result = await relay({ ...REQUEST_BODY, stream: true })

    expect(result).toEqual({ statusCode: 200, streaming: true })
    expect(droidUsageWindowService.onRequestSucceeded).toHaveBeenCalledWith(
      OAUTH_ACCOUNT,
      expect.any(Number)
    )
  })
})

describe('all accounts exhausted', () => {
  const now = Date.UTC(2026, 8, 30, 4, 0, 0)
  let dateNowSpy

  beforeEach(() => {
    dateNowSpy = jest.spyOn(Date, 'now').mockReturnValue(now)
  })

  afterEach(() => {
    dateNowSpy.mockRestore()
  })

  it('returns 429 with reset headers capped at 15 minutes and the real time in the message', async () => {
    // 真实最早恢复在 2 小时后：头里只宣告 15 分钟，sub2api 到点重试
    const resetAt = now + 2 * 3600 * 1000 + 500
    droidScheduler.selectAccount.mockRejectedValueOnce(
      new droidScheduler.DroidAccountsExhaustedError(resetAt)
    )

    const result = await relay(REQUEST_BODY)

    expect(result.statusCode).toBe(429)
    expect(result.headers).toEqual({
      'Content-Type': 'application/json',
      'retry-after': String(15 * 60),
      'anthropic-ratelimit-unified-reset': String(Math.ceil((now + 15 * 60 * 1000) / 1000))
    })
    const body = JSON.parse(result.body)
    expect(body.error).toEqual(
      expect.objectContaining({ type: 'rate_limit_error', code: 'droid_accounts_exhausted' })
    )
    expect(body.error.message).toContain('2026-09-30 14:00 (UTC+8)')
    expect(upstreamErrorHelper.markTempUnavailable).not.toHaveBeenCalled()
    expect(axios).not.toHaveBeenCalled()
  })

  it('advertises the real reset time when it is within 15 minutes', async () => {
    const resetAt = now + 4 * 60 * 1000 + 300
    droidScheduler.selectAccount.mockRejectedValueOnce(
      new droidScheduler.DroidAccountsExhaustedError(resetAt)
    )

    const result = await relay(REQUEST_BODY)

    expect(result.headers['retry-after']).toBe(String(4 * 60 + 1))
    expect(result.headers['anthropic-ratelimit-unified-reset']).toBe(
      String(Math.ceil(resetAt / 1000))
    )
  })

  it('never advertises a reset in the past', async () => {
    droidScheduler.selectAccount.mockRejectedValueOnce(
      new droidScheduler.DroidAccountsExhaustedError(now - 5000)
    )

    const result = await relay(REQUEST_BODY)

    expect(result.headers['retry-after']).toBe('1')
    expect(Number(result.headers['anthropic-ratelimit-unified-reset'])).toBeGreaterThan(now / 1000)
  })
})
