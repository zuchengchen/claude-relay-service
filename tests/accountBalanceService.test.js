// Mock logger，避免测试输出污染控制台
jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
}))

const accountBalanceServiceModule = require('../src/services/account/accountBalanceService')

const { AccountBalanceService } = accountBalanceServiceModule

describe('AccountBalanceService', () => {
  const originalBalanceScriptEnabled = process.env.BALANCE_SCRIPT_ENABLED

  afterEach(() => {
    if (originalBalanceScriptEnabled === undefined) {
      delete process.env.BALANCE_SCRIPT_ENABLED
    } else {
      process.env.BALANCE_SCRIPT_ENABLED = originalBalanceScriptEnabled
    }
  })

  const mockLogger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  }

  const buildMockRedis = () => ({
    getLocalBalance: jest.fn().mockResolvedValue(null),
    setLocalBalance: jest.fn().mockResolvedValue(undefined),
    getAccountBalance: jest.fn().mockResolvedValue(null),
    setAccountBalance: jest.fn().mockResolvedValue(undefined),
    deleteAccountBalance: jest.fn().mockResolvedValue(undefined),
    getBalanceScriptConfig: jest.fn().mockResolvedValue(null),
    getAccountUsageStats: jest.fn().mockResolvedValue({
      total: { requests: 10 },
      daily: { requests: 2, cost: 20 },
      monthly: { requests: 5 }
    }),
    getDateInTimezone: (date) => new Date(date.getTime() + 8 * 3600 * 1000)
  })

  it('should normalize platform aliases', () => {
    const service = new AccountBalanceService({ redis: buildMockRedis(), logger: mockLogger })
    expect(service.normalizePlatform('claude-official')).toBe('claude')
    expect(service.normalizePlatform('azure-openai')).toBe('azure_openai')
    expect(service.normalizePlatform('gemini-api')).toBe('gemini-api')
  })

  it('should build local quota/balance from dailyQuota and local dailyCost', async () => {
    const mockRedis = buildMockRedis()
    const service = new AccountBalanceService({ redis: mockRedis, logger: mockLogger })

    service._computeMonthlyCost = jest.fn().mockResolvedValue(30)
    service._computeTotalCost = jest.fn().mockResolvedValue(123.45)

    const account = { id: 'acct-1', name: 'A', dailyQuota: '100', quotaResetTime: '00:00' }
    const result = await service._getAccountBalanceForAccount(account, 'claude-console', {
      queryApi: false,
      useCache: true
    })

    expect(result.success).toBe(true)
    expect(result.data.source).toBe('local')
    expect(result.data.balance.amount).toBeCloseTo(80, 6)
    expect(result.data.quota.percentage).toBeCloseTo(20, 6)
    expect(result.data.statistics.totalCost).toBeCloseTo(123.45, 6)
    expect(mockRedis.setLocalBalance).toHaveBeenCalled()
  })

  it('should use cached balance when account has no dailyQuota', async () => {
    const mockRedis = buildMockRedis()
    mockRedis.getAccountBalance.mockResolvedValue({
      status: 'success',
      balance: 12.34,
      currency: 'USD',
      quota: null,
      errorMessage: '',
      lastRefreshAt: '2025-01-01T00:00:00Z',
      ttlSeconds: 120
    })

    const service = new AccountBalanceService({ redis: mockRedis, logger: mockLogger })
    service._computeMonthlyCost = jest.fn().mockResolvedValue(0)
    service._computeTotalCost = jest.fn().mockResolvedValue(0)

    const account = { id: 'acct-2', name: 'B' }
    const result = await service._getAccountBalanceForAccount(account, 'openai', {
      queryApi: false,
      useCache: true
    })

    expect(result.data.source).toBe('cache')
    expect(result.data.balance.amount).toBeCloseTo(12.34, 6)
    expect(result.data.lastRefreshAt).toBe('2025-01-01T00:00:00Z')
  })

  it('should not cache provider errors and fallback to local when queryApi=true', async () => {
    const mockRedis = buildMockRedis()
    const service = new AccountBalanceService({ redis: mockRedis, logger: mockLogger })

    service._computeMonthlyCost = jest.fn().mockResolvedValue(0)
    service._computeTotalCost = jest.fn().mockResolvedValue(0)

    service.registerProvider('openai', {
      queryBalance: () => {
        throw new Error('boom')
      }
    })

    const account = { id: 'acct-3', name: 'C' }
    const result = await service._getAccountBalanceForAccount(account, 'openai', {
      queryApi: true,
      useCache: false
    })

    expect(mockRedis.setAccountBalance).not.toHaveBeenCalled()
    expect(result.data.source).toBe('local')
    expect(result.data.status).toBe('error')
    expect(result.data.error).toBe('boom')
  })

  it('should ignore script config when balance script is disabled', async () => {
    process.env.BALANCE_SCRIPT_ENABLED = 'false'

    const mockRedis = buildMockRedis()
    mockRedis.getBalanceScriptConfig.mockResolvedValue({
      scriptBody: '({ request: { url: "http://example.com" }, extractor: function(){ return {} } })'
    })

    const service = new AccountBalanceService({ redis: mockRedis, logger: mockLogger })
    service._computeMonthlyCost = jest.fn().mockResolvedValue(0)
    service._computeTotalCost = jest.fn().mockResolvedValue(0)

    const provider = { queryBalance: jest.fn().mockResolvedValue({ balance: 1, currency: 'USD' }) }
    service.registerProvider('openai', provider)

    const scriptSpy = jest.spyOn(service, '_getBalanceFromScript')

    const account = { id: 'acct-script-off', name: 'S' }
    const result = await service._getAccountBalanceForAccount(account, 'openai', {
      queryApi: true,
      useCache: false
    })

    expect(provider.queryBalance).toHaveBeenCalled()
    expect(scriptSpy).not.toHaveBeenCalled()
    expect(result.data.source).toBe('api')
  })

  it('should prefer script when configured and enabled', async () => {
    process.env.BALANCE_SCRIPT_ENABLED = 'true'

    const mockRedis = buildMockRedis()
    mockRedis.getBalanceScriptConfig.mockResolvedValue({
      scriptBody: '({ request: { url: "http://example.com" }, extractor: function(){ return {} } })'
    })

    const service = new AccountBalanceService({ redis: mockRedis, logger: mockLogger })
    service._computeMonthlyCost = jest.fn().mockResolvedValue(0)
    service._computeTotalCost = jest.fn().mockResolvedValue(0)

    const provider = { queryBalance: jest.fn().mockResolvedValue({ balance: 2, currency: 'USD' }) }
    service.registerProvider('openai', provider)

    jest.spyOn(service, '_getBalanceFromScript').mockResolvedValue({
      status: 'success',
      balance: 3,
      currency: 'USD',
      quota: null,
      queryMethod: 'script',
      rawData: { ok: true },
      lastRefreshAt: '2025-01-01T00:00:00Z',
      errorMessage: ''
    })

    const account = { id: 'acct-script-on', name: 'T' }
    const result = await service._getAccountBalanceForAccount(account, 'openai', {
      queryApi: true,
      useCache: false
    })

    expect(provider.queryBalance).not.toHaveBeenCalled()
    expect(result.data.source).toBe('api')
    expect(result.data.balance.amount).toBeCloseTo(3, 6)
    expect(result.data.lastRefreshAt).toBe('2025-01-01T00:00:00Z')
  })

  describe('droid queryApi=auto', () => {
    const factoryQuota = {
      type: 'factory_tokens',
      total: 20000000,
      used: 19924104,
      remaining: 75896,
      percentage: 99.62,
      overage: 0,
      resetAt: null
    }

    const buildService = (mockRedis) => {
      process.env.BALANCE_SCRIPT_ENABLED = 'false'
      const service = new AccountBalanceService({ redis: mockRedis, logger: mockLogger })
      service._computeMonthlyCost = jest.fn().mockResolvedValue(0)
      service._computeTotalCost = jest.fn().mockResolvedValue(0)
      return service
    }

    it('should call provider and cache result when no cache exists', async () => {
      const mockRedis = buildMockRedis()
      const service = buildService(mockRedis)

      const provider = {
        queryBalance: jest.fn().mockResolvedValue({
          balance: null,
          currency: 'USD',
          queryMethod: 'api',
          quota: factoryQuota,
          rawData: { standard: {} }
        })
      }
      service.registerProvider('droid', provider)

      const account = { id: 'droid-1', name: 'D1' }
      const result = await service._getAccountBalanceForAccount(account, 'droid', {
        queryApi: 'auto',
        useCache: true
      })

      expect(provider.queryBalance).toHaveBeenCalledWith(account)
      expect(mockRedis.setAccountBalance).toHaveBeenCalledWith(
        'droid',
        'droid-1',
        expect.objectContaining({ status: 'success', queryMethod: 'api', quota: factoryQuota }),
        service.CACHE_TTL_SECONDS
      )
      expect(result.data.source).toBe('api')
      expect(result.data.status).toBe('success')
      expect(result.data.balance).toBeNull()
      expect(result.data.quota).toEqual(factoryQuota)
    })

    it('should use success cache without calling provider', async () => {
      const mockRedis = buildMockRedis()
      mockRedis.getAccountBalance.mockResolvedValue({
        status: 'success',
        balance: null,
        currency: 'USD',
        quota: factoryQuota,
        errorMessage: '',
        lastRefreshAt: '2026-09-30T00:00:00Z',
        ttlSeconds: 1800
      })
      const service = buildService(mockRedis)

      const provider = { queryBalance: jest.fn() }
      service.registerProvider('droid', provider)

      const result = await service._getAccountBalanceForAccount(
        { id: 'droid-2', name: 'D2' },
        'droid',
        { queryApi: 'auto', useCache: true }
      )

      expect(mockRedis.getAccountBalance).toHaveBeenCalledWith('droid', 'droid-2')
      expect(provider.queryBalance).not.toHaveBeenCalled()
      expect(mockRedis.setAccountBalance).not.toHaveBeenCalled()
      expect(result.data.source).toBe('cache')
      expect(result.data.quota).toEqual(factoryQuota)
      expect(result.data.lastRefreshAt).toBe('2026-09-30T00:00:00Z')
    })

    it('should share one provider call for concurrent requests of the same account', async () => {
      const mockRedis = buildMockRedis()
      const service = buildService(mockRedis)

      let resolveQuery
      const provider = {
        queryBalance: jest.fn(
          () =>
            new Promise((resolve) => {
              resolveQuery = resolve
            })
        )
      }
      service.registerProvider('droid', provider)

      const account = { id: 'droid-concurrent', name: 'DC' }
      const options = { queryApi: 'auto', useCache: true }
      const first = service._getAccountBalanceForAccount(account, 'droid', options)
      const second = service._getAccountBalanceForAccount(account, 'droid', options)

      // 等两个请求都走到 provider 调用处
      await new Promise((resolve) => setImmediate(resolve))
      resolveQuery({ balance: null, queryMethod: 'api', quota: factoryQuota })
      const [r1, r2] = await Promise.all([first, second])

      expect(provider.queryBalance).toHaveBeenCalledTimes(1)
      expect(mockRedis.setAccountBalance).toHaveBeenCalledTimes(1)
      expect(r1.data.quota).toEqual(factoryQuota)
      expect(r2.data.quota).toEqual(factoryQuota)
      expect(service.inFlight.size).toBe(0)
    })

    it('should keep auto as local for platforms outside the whitelist', async () => {
      const mockRedis = buildMockRedis()
      const service = buildService(mockRedis)

      const provider = { queryBalance: jest.fn() }
      service.registerProvider('openai', provider)

      const result = await service._getAccountBalanceForAccount(
        { id: 'acct-auto', name: 'X' },
        'openai',
        { queryApi: 'auto', useCache: true }
      )

      expect(provider.queryBalance).not.toHaveBeenCalled()
      expect(result.data.source).toBe('local')
    })
  })

  it('should count low balance once per account in summary', async () => {
    const mockRedis = buildMockRedis()
    const service = new AccountBalanceService({ redis: mockRedis, logger: mockLogger })

    service.getSupportedPlatforms = () => ['claude-console']
    service.getAllAccountsByPlatform = async () => [{ id: 'acct-4', name: 'D' }]
    service._getAccountBalanceForAccount = async () => ({
      success: true,
      data: {
        accountId: 'acct-4',
        platform: 'claude-console',
        balance: { amount: 5, currency: 'USD', formattedAmount: '$5.00' },
        quota: { percentage: 95 },
        statistics: { totalCost: 1 },
        source: 'local',
        lastRefreshAt: '2025-01-01T00:00:00Z',
        cacheExpiresAt: null,
        status: 'success',
        error: null
      }
    })

    const summary = await service.getBalanceSummary()
    expect(summary.lowBalanceCount).toBe(1)
    expect(summary.platforms['claude-console'].lowBalanceCount).toBe(1)
  })
})
