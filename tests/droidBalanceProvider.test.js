// Mock logger，避免测试输出污染控制台
jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
}))

// 真实的 droidAccountService 构造函数里有 setInterval，会让 Jest 挂住，这里整体 mock
jest.mock('../src/services/account/droidAccountService', () => ({
  getAccount: jest.fn(),
  getDecryptedApiKeyEntries: jest.fn(),
  getValidAccessToken: jest.fn(),
  refreshAccessToken: jest.fn()
}))

jest.mock('../src/services/relay/droidRelayService', () => ({
  userAgent: 'factory-cli/test-ua'
}))

const droidAccountService = require('../src/services/account/droidAccountService')
const DroidBalanceProvider = require('../src/services/balanceProviders/droidBalanceProvider')

const TOKEN = 'eyJhbGciOiJSUzI1NiJ9.secret-payload.secret-signature'
const CHAT_USAGE_URL = 'https://app.factory.ai/api/organization/members/chat-usage'

const buildUsageResponse = (standardOverrides = {}, usageOverrides = {}) => ({
  success: true,
  status: 200,
  data: {
    usage: {
      startDate: 1790665451546,
      endDate: null,
      standard: {
        userTokens: 19924104,
        orgTotalTokensUsed: 19924104,
        orgOverageUsed: 0,
        basicAllowance: 20000000,
        totalAllowance: 20000000,
        orgOverageLimit: 0,
        usedRatio: 0.9962052,
        ...standardOverrides
      },
      premium: { userTokens: 0, totalAllowance: 0, usedRatio: 0 },
      ...usageOverrides
    }
  }
})

describe('DroidBalanceProvider', () => {
  let provider

  beforeEach(() => {
    jest.clearAllMocks()
    droidAccountService.getAccount.mockResolvedValue(null)
    droidAccountService.getDecryptedApiKeyEntries.mockResolvedValue([])
    provider = new DroidBalanceProvider()
    jest.spyOn(provider, 'makeRequest').mockResolvedValue(buildUsageResponse())
  })

  it('uses stored Bearer accessToken for OAuth accounts and maps fields', async () => {
    droidAccountService.getAccount.mockResolvedValue({
      id: 'droid-oauth',
      authenticationMethod: 'GoogleOAuth',
      accessToken: TOKEN,
      proxy: ''
    })
    const endDate = Date.UTC(2026, 9, 29, 7, 4, 11)
    provider.makeRequest.mockResolvedValue(buildUsageResponse({}, { endDate }))

    // 批量路径传入的 accessToken 是打码的，provider 必须按 id 重新取账户
    const result = await provider.queryBalance({ id: 'droid-oauth', accessToken: 'eyJ***masked' })

    expect(droidAccountService.getAccount).toHaveBeenCalledWith('droid-oauth')
    const [url, options, proxyArg] = provider.makeRequest.mock.calls[0]
    expect(url).toBe(CHAT_USAGE_URL)
    expect(options.headers).toEqual(
      expect.objectContaining({
        Authorization: `Bearer ${TOKEN}`,
        'x-factory-client': 'cli',
        Accept: 'application/json',
        'User-Agent': 'factory-cli/test-ua'
      })
    )
    expect(proxyArg).toEqual({ proxy: '' })

    expect(result.balance).toBeNull()
    expect(result.currency).toBe('USD')
    expect(result.queryMethod).toBe('api')
    expect(result.quota).toEqual({
      type: 'factory_tokens',
      total: 20000000,
      used: 19924104,
      remaining: 75896,
      percentage: 99.62,
      overage: 0,
      resetAt: new Date(endDate).toISOString()
    })
    expect(result.rawData.standard.totalAllowance).toBe(20000000)
  })

  it('skips api keys with status=error for api_key accounts', async () => {
    droidAccountService.getAccount.mockResolvedValue({
      id: 'droid-key',
      authenticationMethod: ' API_KEY ',
      accessToken: '',
      userAgent: 'custom-ua/1.0'
    })
    droidAccountService.getDecryptedApiKeyEntries.mockResolvedValue([
      { id: 'k1', key: 'fk-broken', status: 'error' },
      { id: 'k2', key: 'fk-active', status: 'active' }
    ])
    // 没有 usedRatio 时按 used / total 计算；endDate 为 null 时 resetAt = startDate + 7d
    provider.makeRequest.mockResolvedValue(
      buildUsageResponse({ userTokens: 250, totalAllowance: 1000, usedRatio: undefined })
    )

    const result = await provider.queryBalance({ id: 'droid-key' })

    expect(droidAccountService.getDecryptedApiKeyEntries).toHaveBeenCalledWith('droid-key')
    const [, options] = provider.makeRequest.mock.calls[0]
    expect(options.headers.Authorization).toBe('Bearer fk-active')
    expect(options.headers['User-Agent']).toBe('custom-ua/1.0')
    expect(result.quota).toEqual(
      expect.objectContaining({ total: 1000, used: 250, remaining: 750, percentage: 25 })
    )
    expect(result.quota.resetAt).toBe(new Date(1790665451546 + 7 * 24 * 3600 * 1000).toISOString())
  })

  it('leaves resetAt null when neither endDate nor startDate is present', async () => {
    droidAccountService.getAccount.mockResolvedValue({
      id: 'droid-nodates',
      authenticationMethod: 'GoogleOAuth',
      accessToken: TOKEN
    })
    provider.makeRequest.mockResolvedValue(buildUsageResponse({}, { startDate: null }))

    const result = await provider.queryBalance({ id: 'droid-nodates' })

    expect(result.quota.resetAt).toBeNull()
  })

  it('throws credential error on 401 without leaking the token', async () => {
    droidAccountService.getAccount.mockResolvedValue({
      id: 'droid-401',
      authenticationMethod: 'GoogleOAuth',
      accessToken: TOKEN
    })
    provider.makeRequest.mockResolvedValue({ success: false, status: 401, error: 'Unauthorized' })

    const error = await provider.queryBalance({ id: 'droid-401' }).catch((e) => e)

    expect(error).toBeInstanceOf(Error)
    expect(error.message).toBe('Factory 凭证无效或已过期（下次转发会自动刷新）')
    expect(error.message).not.toContain(TOKEN)
  })

  it('reports other HTTP failures with status and redacts the credential', async () => {
    droidAccountService.getAccount.mockResolvedValue({
      id: 'droid-502',
      authenticationMethod: 'GoogleOAuth',
      accessToken: TOKEN
    })
    provider.makeRequest.mockResolvedValue({
      success: false,
      status: 502,
      error: `upstream echoed ${TOKEN}`
    })

    const error = await provider.queryBalance({ id: 'droid-502' }).catch((e) => e)

    expect(error.message).toContain('Factory 配额查询失败: HTTP 502')
    expect(error.message).not.toContain(TOKEN)
  })

  it('throws format error when usage.standard is missing', async () => {
    droidAccountService.getAccount.mockResolvedValue({
      id: 'droid-format',
      authenticationMethod: 'GoogleOAuth',
      accessToken: TOKEN
    })
    provider.makeRequest.mockResolvedValue({ success: true, status: 200, data: { usage: {} } })

    await expect(provider.queryBalance({ id: 'droid-format' })).rejects.toThrow(
      'Factory 配额响应格式无法识别'
    )
  })

  it('throws when no usable credential exists', async () => {
    droidAccountService.getAccount.mockResolvedValueOnce({
      id: 'droid-empty',
      authenticationMethod: 'GoogleOAuth',
      accessToken: ''
    })
    await expect(provider.queryBalance({ id: 'droid-empty' })).rejects.toThrow('缺少可用凭证')

    droidAccountService.getAccount.mockResolvedValueOnce({
      id: 'droid-keys-dead',
      authenticationMethod: 'api_key'
    })
    droidAccountService.getDecryptedApiKeyEntries.mockResolvedValueOnce([
      { id: 'k1', key: 'fk-broken', status: 'error' }
    ])
    await expect(provider.queryBalance({ id: 'droid-keys-dead' })).rejects.toThrow('缺少可用凭证')

    expect(provider.makeRequest).not.toHaveBeenCalled()
  })

  it('throws when the account no longer exists', async () => {
    await expect(provider.queryBalance({ id: 'droid-missing' })).rejects.toThrow('账户不存在')
    expect(provider.makeRequest).not.toHaveBeenCalled()
  })

  it('throws format error when totalAllowance is missing instead of reporting 0%', async () => {
    droidAccountService.getAccount.mockResolvedValue({
      id: 'droid-noallowance',
      authenticationMethod: 'GoogleOAuth',
      accessToken: TOKEN
    })
    provider.makeRequest.mockResolvedValue(buildUsageResponse({ totalAllowance: undefined }))

    await expect(provider.queryBalance({ id: 'droid-noallowance' })).rejects.toThrow(
      'Factory 配额响应格式无法识别'
    )
  })

  it('shows 100% when allowance is 0 but tokens were used', async () => {
    droidAccountService.getAccount.mockResolvedValue({
      id: 'droid-zero',
      authenticationMethod: 'GoogleOAuth',
      accessToken: TOKEN
    })
    provider.makeRequest.mockResolvedValue(
      buildUsageResponse({ totalAllowance: 0, userTokens: 500, usedRatio: 0 })
    )

    const result = await provider.queryBalance({ id: 'droid-zero' })

    expect(result.quota).toEqual(
      expect.objectContaining({ total: 0, used: 500, remaining: 0, percentage: 100 })
    )
  })

  it('tells api_key accounts to replace the key on 401', async () => {
    droidAccountService.getAccount.mockResolvedValue({
      id: 'droid-key-401',
      authenticationMethod: 'api_key'
    })
    droidAccountService.getDecryptedApiKeyEntries.mockResolvedValue([
      { id: 'k1', key: 'fk-revoked', status: 'active' }
    ])
    provider.makeRequest.mockResolvedValue({ success: false, status: 401, error: 'Unauthorized' })

    await expect(provider.queryBalance({ id: 'droid-key-401' })).rejects.toThrow(
      'Factory API Key 无效或已失效，请更换'
    )
  })

  it('never refreshes tokens', async () => {
    droidAccountService.getAccount.mockResolvedValue({
      id: 'droid-norefresh',
      authenticationMethod: 'MagicAuth',
      accessToken: TOKEN
    })

    await provider.queryBalance({ id: 'droid-norefresh' })
    provider.makeRequest.mockResolvedValue({ success: false, status: 401, error: 'expired' })
    await provider.queryBalance({ id: 'droid-norefresh' }).catch(() => {})

    expect(droidAccountService.getValidAccessToken).not.toHaveBeenCalled()
    expect(droidAccountService.refreshAccessToken).not.toHaveBeenCalled()
  })
})
