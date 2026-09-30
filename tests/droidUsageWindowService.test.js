jest.mock('../src/models/redis', () => {
  const FakeRedis = require('./helpers/fakeRedis')
  const client = new FakeRedis()
  return {
    __fake: client,
    getClientSafe: () => client,
    getDroidAccount: jest.fn(async () => ({})),
    getAllDroidAccounts: jest.fn(async () => []),
    getAccountLocalCostsSince: jest.fn(async (_id, sinces) => sinces.map(() => 0))
  }
})
jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn()
}))
jest.mock('../src/services/droidUsageLimitService', () => ({
  getActiveLimits: jest.fn(async () => ({})),
  recordLimit: jest.fn(async (_id, limit, options = {}) => ({
    ...limit,
    source: options.source || '402'
  }))
}))

const redis = require('../src/models/redis')
const droidUsageLimitService = require('../src/services/droidUsageLimitService')
const service = require('../src/services/droidUsageWindowService')
const FakeRedis = require('./helpers/fakeRedis')

const { KEYS, DEFAULT_SETTINGS, computeAccountWindows, planCostSinces, computePoolRatio } = service

const MIN = 60 * 1000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const WEEK = 7 * DAY
const T0 = Date.UTC(2026, 8, 30, 4, 0, 0)
const ACCOUNT = { id: 'acct-1', name: 'bb6' }

const usage = ({ userTokens = 0, totalAllowance = 20000000, startDate = T0 - DAY } = {}) => ({
  rawData: {
    startDate,
    endDate: null,
    standard: { userTokens, totalAllowance, orgOverageUsed: 0, usedRatio: userTokens / 2e7 }
  }
})

let now
let provider
let dateNowSpy

const resetFake = () => {
  const fresh = new FakeRedis()
  Object.assign(redis.__fake, {
    strings: fresh.strings,
    hashes: fresh.hashes,
    lists: fresh.lists,
    expiry: fresh.expiry
  })
}
const readJson = async (key) => JSON.parse(await redis.__fake.get(key))

beforeEach(() => {
  jest.clearAllMocks()
  resetFake()
  now = T0
  dateNowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now)
  provider = { queryBalance: jest.fn() }
  service._provider = provider
  service._inflightSnapshots.clear()
})

afterEach(() => {
  dateNowSpy.mockRestore()
})

describe('onRequestSucceeded', () => {
  it('opens the 5h window only once (SET NX) and records a baseline', async () => {
    provider.queryBalance.mockResolvedValue(usage({ userTokens: 1000000 }))

    const first = await service.onRequestSucceeded(ACCOUNT, T0 - 5000)
    expect(first.fiveHour).toEqual(expect.objectContaining({ start: T0 - 5000 }))
    expect(first.thirtyDay).toEqual(expect.objectContaining({ start: T0 - 5000 }))
    expect(first.baseline).toEqual(
      expect.objectContaining({ baselineTokens: 1000000, baselineStartDate: T0 - DAY })
    )

    const stored = await readJson(KEYS.window5h(ACCOUNT.id))
    expect(stored).toEqual(
      expect.objectContaining({
        start: T0 - 5000,
        end: T0 - 5000 + 5 * HOUR,
        baselineTokens: 1000000
      })
    )

    now = T0 + HOUR
    const second = await service.onRequestSucceeded(ACCOUNT, now)
    expect(second.fiveHour).toBeNull()
    expect(second.thirtyDay).toBeNull()
    expect(provider.queryBalance).toHaveBeenCalledTimes(1)
    expect((await readJson(KEYS.window5h(ACCOUNT.id))).start).toBe(T0 - 5000)
  })

  it('opens a new window once the old one has expired', async () => {
    provider.queryBalance.mockResolvedValue(usage({ userTokens: 1000000 }))
    await service.onRequestSucceeded(ACCOUNT, T0)

    now = T0 + 5 * HOUR + MIN
    provider.queryBalance.mockResolvedValue(usage({ userTokens: 7000000 }))
    const next = await service.onRequestSucceeded(ACCOUNT, now)

    expect(next.fiveHour.start).toBe(now)
    expect(next.baseline.baselineTokens).toBe(7000000)
  })
})

describe('onUsageLimit (5h)', () => {
  const seedWindow = async (record) => {
    await redis.__fake.set(
      KEYS.window5h(ACCOUNT.id),
      JSON.stringify(record),
      'PX',
      record.end - now
    )
  }

  it('corrects the window and samples the cap only once', async () => {
    const trueStart = T0 - 3 * HOUR
    await seedWindow({
      start: trueStart + 20 * 1000,
      end: trueStart + 20 * 1000 + 5 * HOUR,
      baselineTokens: 2000000,
      baselineStartDate: T0 - DAY,
      baselineAt: trueStart + 60 * 1000,
      capSampled: false
    })
    provider.queryBalance.mockResolvedValue(usage({ userTokens: 8000000 }))

    const resetAt = trueStart + 5 * HOUR + 90 * 1000
    const result = await service.onUsageLimit(ACCOUNT, { window: 'fiveHour', resetAt })

    expect(result.window).toEqual(
      expect.objectContaining({
        start: resetAt - 5 * HOUR,
        end: resetAt,
        baselineTokens: 2000000,
        capSampled: true
      })
    )
    expect(result.sample.capTokens).toBe(6000000)
    const samples = await redis.__fake.lrange(KEYS.capSamples('5h'), 0, -1)
    expect(samples).toHaveLength(1)

    // 同一窗口再来一次 402：不再采样
    const again = await service.onUsageLimit(ACCOUNT, { window: 'fiveHour', resetAt })
    expect(again.sample).toBeNull()
    expect(provider.queryBalance).toHaveBeenCalledTimes(1)
    expect(await redis.__fake.lrange(KEYS.capSamples('5h'), 0, -1)).toHaveLength(1)
  })

  it('samples only once when two 402s for the same window arrive concurrently', async () => {
    const trueStart = T0 - 3 * HOUR
    await seedWindow({
      start: trueStart + 20 * 1000,
      end: trueStart + 20 * 1000 + 5 * HOUR,
      baselineTokens: 2000000,
      baselineStartDate: T0 - DAY,
      baselineAt: trueStart + 60 * 1000,
      capSampled: false
    })
    provider.queryBalance.mockResolvedValue(usage({ userTokens: 8000000 }))

    // 两个并发 402：倒计时向下取整，解析出的 resetAt 可能差几秒
    const [a, b] = await Promise.all([
      service.onUsageLimit(ACCOUNT, { window: 'fiveHour', resetAt: trueStart + 5 * HOUR + 90000 }),
      service.onUsageLimit(ACCOUNT, { window: 'fiveHour', resetAt: trueStart + 5 * HOUR + 91000 })
    ])

    expect([a.sample, b.sample].filter(Boolean)).toHaveLength(1)
    expect(await redis.__fake.lrange(KEYS.capSamples('5h'), 0, -1)).toHaveLength(1)
    expect(a.window.capSampled && b.window.capSampled).toBe(true)
  })

  it('skips sampling when the Factory week changed since the baseline', async () => {
    const trueStart = T0 - 2 * HOUR
    await seedWindow({
      start: trueStart,
      end: trueStart + 5 * HOUR,
      baselineTokens: 2000000,
      baselineStartDate: T0 - 8 * DAY,
      baselineAt: trueStart + MIN,
      capSampled: false
    })
    provider.queryBalance.mockResolvedValue(usage({ userTokens: 500000, startDate: T0 - HOUR }))

    const result = await service.onUsageLimit(ACCOUNT, {
      window: 'fiveHour',
      resetAt: trueStart + 5 * HOUR + 90 * 1000
    })

    expect(result.sample).toBeNull()
    expect(await redis.__fake.lrange(KEYS.capSamples('5h'), 0, -1)).toHaveLength(0)
  })

  it('does not sample when the baseline is not aligned with the corrected window', async () => {
    // relay 上线时账号已经在 Factory 窗口中间：baseline 远晚于真实窗口起点
    const trueStart = T0 - 4 * HOUR
    await seedWindow({
      start: T0 - HOUR,
      end: T0 + 4 * HOUR,
      baselineTokens: 5000000,
      baselineStartDate: T0 - DAY,
      baselineAt: T0 - HOUR + MIN,
      capSampled: false
    })

    const result = await service.onUsageLimit(ACCOUNT, {
      window: 'fiveHour',
      resetAt: trueStart + 5 * HOUR + 90 * 1000
    })

    expect(result.sample).toBeNull()
    expect(provider.queryBalance).not.toHaveBeenCalled()
    expect(result.window).toEqual(
      expect.objectContaining({
        start: trueStart + 90 * 1000,
        baselineTokens: null,
        capSampled: false
      })
    )
  })

  it('creates the corrected window without a baseline when none existed', async () => {
    const resetAt = T0 + 2 * HOUR
    const result = await service.onUsageLimit(ACCOUNT, { window: 'fiveHour', resetAt })

    expect(result.window).toEqual(
      expect.objectContaining({ start: resetAt - 5 * HOUR, end: resetAt, baselineTokens: null })
    )
    expect(result.sample).toBeNull()
    expect(await redis.__fake.pttl(KEYS.window5h(ACCOUNT.id))).toBe(2 * HOUR)
  })
})

describe('onUsageLimit (7d)', () => {
  it('refines resetAt with startDate + 7d and marks the week capped', async () => {
    const startDate = T0 - DAY - 3 * HOUR
    provider.queryBalance.mockResolvedValue(usage({ userTokens: 19950000, startDate }))

    // "resets in 5 days"：真实剩余 5d 21h
    const parsedResetAt = T0 + 5 * DAY + 90 * 1000
    const result = await service.onUsageLimit(ACCOUNT, {
      window: 'sevenDay',
      resetAt: parsedResetAt,
      detail: 'weekly'
    })

    const refined = startDate + WEEK
    expect(droidUsageLimitService.recordLimit).toHaveBeenCalledWith(
      ACCOUNT.id,
      { window: 'sevenDay', resetAt: refined + 90 * 1000, detail: 'weekly' },
      { source: 'chat-usage' }
    )
    expect(result.refinedResetAt).toBe(refined + 90 * 1000)

    const week = JSON.parse(await redis.__fake.hget(KEYS.week(ACCOUNT.id), String(startDate)))
    expect(week).toEqual(expect.objectContaining({ capped: true, maxUserTokens: 19950000 }))
  })

  it('keeps the 402 value when chat-usage does not line up', async () => {
    provider.queryBalance.mockResolvedValue(usage({ userTokens: 100, startDate: T0 - HOUR }))

    const result = await service.onUsageLimit(ACCOUNT, {
      window: 'sevenDay',
      resetAt: T0 + 2 * DAY + 90 * 1000
    })

    expect(result.refinedResetAt).toBeNull()
    expect(droidUsageLimitService.recordLimit).not.toHaveBeenCalled()
  })
})

describe('onUsageLimit (30d)', () => {
  it('samples only once for concurrent 30d 402s', async () => {
    provider.queryBalance.mockResolvedValue(usage({ userTokens: 15000000, startDate: T0 - DAY }))
    const resetAt = T0 + 10 * DAY

    const results = await Promise.all([
      service.onUsageLimit(ACCOUNT, { window: 'thirtyDay', resetAt }),
      service.onUsageLimit(ACCOUNT, { window: 'thirtyDay', resetAt: resetAt + 1000 })
    ])

    expect(results.map((item) => item.sample).filter(Boolean)).toHaveLength(1)
    expect(await redis.__fake.lrange(KEYS.capSamples('30d'), 0, -1)).toHaveLength(1)
  })
})

describe('week records', () => {
  it('drops weeks that ended before the retention period', async () => {
    const key = KEYS.week(ACCOUNT.id)
    const oldStart = T0 - 60 * DAY
    const recentStart = T0 - 20 * DAY
    await redis.__fake.hset(key, String(oldStart), JSON.stringify({ startDate: oldStart }))
    await redis.__fake.hset(key, String(recentStart), JSON.stringify({ startDate: recentStart }))
    provider.queryBalance.mockResolvedValue(usage({ userTokens: 1000, startDate: T0 - DAY }))

    await service.getSnapshot(ACCOUNT.id, { force: true })

    expect(Object.keys(await redis.__fake.hgetall(key)).sort()).toEqual(
      [String(recentStart), String(T0 - DAY)].sort()
    )
  })
})

describe('getSnapshot', () => {
  it('uses the cache, bypasses it on force, and dedupes concurrent fetches', async () => {
    provider.queryBalance.mockResolvedValue(usage({ userTokens: 1000 }))
    const first = await service.getSnapshot(ACCOUNT.id)
    expect(first).toEqual({
      snapshot: expect.objectContaining({ userTokens: 1000, fetchedAt: T0 }),
      stale: false,
      error: null
    })

    now = T0 + 60 * 1000
    await service.getSnapshot(ACCOUNT.id)
    expect(provider.queryBalance).toHaveBeenCalledTimes(1)

    provider.queryBalance.mockResolvedValue(usage({ userTokens: 2000 }))
    const [a, b] = await Promise.all([
      service.getSnapshot(ACCOUNT.id, { force: true }),
      service.getSnapshot(ACCOUNT.id, { force: true })
    ])
    expect(provider.queryBalance).toHaveBeenCalledTimes(2)
    expect(a.snapshot.userTokens).toBe(2000)
    expect(b).toBe(a)

    now = T0 + 60 * 1000 + DEFAULT_SETTINGS.snapshotCacheSeconds * 1000 + 1
    await service.getSnapshot(ACCOUNT.id)
    expect(provider.queryBalance).toHaveBeenCalledTimes(3)
  })

  it('returns the previous snapshot marked stale when the fetch fails', async () => {
    provider.queryBalance.mockResolvedValueOnce(usage({ userTokens: 1234 }))
    await service.getSnapshot(ACCOUNT.id)

    now = T0 + HOUR
    provider.queryBalance.mockRejectedValueOnce(new Error('Factory 凭证无效或已过期'))
    const result = await service.getSnapshot(ACCOUNT.id)

    expect(result.stale).toBe(true)
    expect(result.error).toBe('Factory 凭证无效或已过期')
    expect(result.snapshot.userTokens).toBe(1234)
  })

  it('returns null snapshot with the error when nothing was cached', async () => {
    provider.queryBalance.mockRejectedValueOnce(new Error('boom'))
    expect(await service.getSnapshot(ACCOUNT.id)).toEqual({
      snapshot: null,
      stale: false,
      error: 'boom'
    })
  })
})

describe('computeAccountWindows', () => {
  const NOW = T0
  const snapshotAt = (overrides = {}) => ({
    userTokens: 10000000,
    totalAllowance: 20000000,
    orgOverageUsed: 0,
    startDate: NOW - 2 * DAY,
    fetchedAt: NOW - 30 * 1000,
    ...overrides
  })
  const compute = (overrides = {}) =>
    computeAccountWindows({
      account: ACCOUNT,
      snapshotResult: { snapshot: snapshotAt(), stale: false, error: null },
      settings: DEFAULT_SETTINGS,
      now: NOW,
      ...overrides
    })

  it('uses the baseline delta for 5h within the same Factory week', () => {
    const result = compute({
      window5h: {
        start: NOW - HOUR,
        end: NOW + 4 * HOUR,
        baselineTokens: 7000000,
        baselineStartDate: NOW - 2 * DAY
      }
    })

    expect(result.windows.fiveHour).toEqual(
      expect.objectContaining({ used: 3000000, cap: 6000000, util: 50, source: 'baseline' })
    )
    expect(result.windows.fiveHour.estimated).toBe(true)
    expect(result.windows.fiveHour.resetAt).toBe(new Date(NOW + 4 * HOUR).toISOString())
  })

  it('falls back to local cost / ratio when the baseline week changed', () => {
    const result = compute({
      window5h: {
        start: NOW - HOUR,
        end: NOW + 4 * HOUR,
        baselineTokens: 7000000,
        baselineStartDate: NOW - 9 * DAY
      },
      costs: { fiveHour: 1.8 },
      poolRatio: 0.9
    })

    expect(result.windows.fiveHour.source).toBe('local')
    expect(result.windows.fiveHour.used).toBe(2000000)
  })

  it('shows an idle 5h window as 0% without reset time', () => {
    const result = compute()
    expect(result.windows.fiveHour).toEqual(
      expect.objectContaining({ util: 0, used: 0, resetAt: null, source: 'idle' })
    )
  })

  it('uses the default 5h cap with fewer than 3 samples and the median otherwise', () => {
    const two = compute({
      capSamples: {
        fiveHour: [
          { capTokens: 4000000, totalAllowance: 20000000 },
          { capTokens: 5000000, totalAllowance: 20000000 }
        ]
      }
    })
    expect(two.windows.fiveHour).toEqual(
      expect.objectContaining({ cap: 6000000, capSource: 'default', capSampleCount: 2 })
    )

    const three = compute({
      capSamples: {
        fiveHour: [
          { capTokens: 6000000, totalAllowance: 20000000 },
          { capTokens: 4000000, totalAllowance: 20000000 },
          { capTokens: 5000000, totalAllowance: 20000000 }
        ]
      }
    })
    expect(three.windows.fiveHour).toEqual(
      expect.objectContaining({ cap: 5000000, capSource: 'samples', capSampleCount: 3 })
    )
  })

  it('sums ended weeks for 30d and floors capped weeks at the allowance', () => {
    const weeks = [
      { startDate: NOW - 40 * DAY, maxUserTokens: 99000000, capped: false },
      { startDate: NOW - 23 * DAY, maxUserTokens: 12000000, totalAllowance: 20000000 },
      {
        startDate: NOW - 16 * DAY,
        maxUserTokens: 17000000,
        totalAllowance: 20000000,
        capped: true
      },
      { startDate: NOW - 2 * DAY, maxUserTokens: 9000000, totalAllowance: 20000000 }
    ]

    const result = compute({ weeks })
    // 12M + max(17M, 20M) + 当前周 max(9M, 快照 10M)
    expect(result.windows.thirtyDay).toEqual(
      expect.objectContaining({
        used: 42000000,
        source: 'weeks',
        estimated: true,
        capSource: 'default'
      })
    )
    expect(result.windows.thirtyDay.cap).toBeCloseTo((20000000 * 30) / 7, 0)

    const sinces = planCostSinces({
      snapshot: snapshotAt(),
      stale: false,
      weeks,
      now: NOW
    })
    expect(sinces.thirtyDay).toBeUndefined()
    expect(sinces.week).toBe(NOW - 2 * DAY)
  })

  it('uses the 30d cap from config, then samples, then allowance × 30/7', () => {
    expect(
      compute({ settings: { ...DEFAULT_SETTINGS, thirtyDayCapTokens: 50000000 } }).windows.thirtyDay
    ).toEqual(expect.objectContaining({ cap: 50000000, capSource: 'config' }))
    expect(
      compute({ capSamples: { thirtyDay: [{ capTokens: 60000000, totalAllowance: 20000000 }] } })
        .windows.thirtyDay
    ).toEqual(expect.objectContaining({ cap: 60000000, capSource: 'samples' }))
  })

  it('resolves the ratio: account → pool → default', () => {
    const own = compute({ costs: { week: 9.07 } })
    expect(own.usd).toEqual(
      expect.objectContaining({ usdPerMTokens: 0.907, ratioSource: 'account', weekly: 18.14 })
    )
    expect(own.usd.monthly).toBeCloseTo((0.907 * 20 * 30) / 7, 1)

    const small = compute({
      snapshotResult: { snapshot: snapshotAt({ userTokens: 1500000 }), stale: false },
      costs: { week: 5 },
      poolRatio: 1.1
    })
    expect(small.usd).toEqual(expect.objectContaining({ usdPerMTokens: 1.1, ratioSource: 'pool' }))

    const stale = compute({
      snapshotResult: { snapshot: snapshotAt(), stale: true, error: 'x' },
      costs: { week: 9.07 }
    })
    expect(stale.usd).toEqual(
      expect.objectContaining({ usdPerMTokens: 0.9, ratioSource: 'default' })
    )
  })

  it('computes the pool ratio from fresh current-week entries only', () => {
    const entries = [
      { snapshotResult: { snapshot: snapshotAt({ userTokens: 20000000 }) }, costs: { week: 20 } },
      { snapshotResult: { snapshot: snapshotAt({ userTokens: 20000000 }) }, costs: { week: 20 } },
      {
        snapshotResult: { snapshot: snapshotAt({ userTokens: 20000000 }), stale: true },
        costs: { week: 100 }
      },
      { snapshotResult: { snapshot: null }, costs: {} }
    ]
    expect(computePoolRatio(entries, NOW)).toBeCloseTo(1, 6)
    expect(computePoolRatio(entries.slice(3), NOW)).toBeNull()
  })

  it('reports 7d from chat-usage, allowing more than 100%', () => {
    const result = compute({
      snapshotResult: {
        snapshot: snapshotAt({ userTokens: 20239445, startDate: NOW - 3 * DAY }),
        stale: false
      }
    })
    expect(result.windows.sevenDay).toEqual(
      expect.objectContaining({
        used: 20239445,
        cap: 20000000,
        util: 101.2,
        estimated: false,
        limited: false,
        source: 'chat-usage',
        resetAt: new Date(NOW + 4 * DAY).toISOString()
      })
    )
  })

  it('forces util ≥ 100 and the precise resetAt when a limit is recorded', () => {
    const limitResetAt = NOW + 4 * DAY + 90 * 1000
    const result = compute({
      limits: { sevenDay: { resetAt: limitResetAt, detail: 'weekly limit' } },
      window5h: null
    })
    expect(result.windows.sevenDay).toEqual(
      expect.objectContaining({
        util: 100,
        limited: true,
        limitDetail: 'weekly limit',
        resetAt: new Date(limitResetAt).toISOString()
      })
    )

    const fiveHour = compute({ limits: { fiveHour: { resetAt: NOW + HOUR } } })
    expect(fiveHour.windows.fiveHour).toEqual(
      expect.objectContaining({
        util: 100,
        limited: true,
        resetAt: new Date(NOW + HOUR).toISOString()
      })
    )
  })

  it('estimates 7d from local cost when there is no usable snapshot', () => {
    const result = compute({
      snapshotResult: { snapshot: null, stale: false, error: 'Factory 凭证无效或已过期' },
      costs: { sevenDayFallback: 9 }
    })
    expect(result.windows.sevenDay).toEqual(
      expect.objectContaining({
        used: 10000000,
        cap: 20000000,
        estimated: true,
        source: 'local',
        resetAt: null
      })
    )
    expect(result.snapshotError).toBe('Factory 凭证无效或已过期')
    expect(result.usd.ratioSource).toBe('default')
  })

  it('uses endDate for the 7d reset when chat-usage provides it (same rule as the balance column)', () => {
    const endDate = NOW + 10 * DAY
    const result = compute({
      snapshotResult: { snapshot: snapshotAt({ startDate: NOW - 8 * DAY, endDate }), stale: false }
    })
    expect(result.windows.sevenDay).toEqual(
      expect.objectContaining({
        source: 'chat-usage',
        resetAt: new Date(endDate).toISOString()
      })
    )
  })

  it('reports the effective 5h cap ratio and sample threshold', () => {
    const result = compute({ settings: { ...DEFAULT_SETTINGS, fiveHourCapRatio: 0.25 } })
    expect(result.windows.fiveHour).toEqual(
      expect.objectContaining({
        cap: 5000000,
        capSource: 'default',
        capRatio: 0.25,
        capMinSamples: 3
      })
    )
  })

  it('never includes credentials in the output', () => {
    const result = compute({
      account: { ...ACCOUNT, accessToken: 'eyJsecret', refreshToken: 'rt-secret' }
    })
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('eyJsecret')
    expect(serialized).not.toContain('rt-secret')
  })
})

describe('getUsageWindows', () => {
  it('builds windows for the requested accounts with a pool ratio', async () => {
    redis.getDroidAccount.mockImplementation(async (id) =>
      id === 'missing' ? {} : { name: id, accessToken: 'encrypted', disableAutoProtection: 'false' }
    )
    provider.queryBalance.mockResolvedValue(usage({ userTokens: 10000000 }))
    redis.getAccountLocalCostsSince.mockImplementation(async (_id, sinces) => sinces.map(() => 9))

    const data = await service.getUsageWindows(['a1', 'a2', 'missing'], { force: true })

    expect(Object.keys(data).sort()).toEqual(['a1', 'a2'])
    expect(data.a1.usd).toEqual(expect.objectContaining({ ratioSource: 'account' }))
    expect(data.a1.usd.usdPerMTokens).toBeCloseTo(0.9, 6)
    expect(data.a1.windows.sevenDay.used).toBe(10000000)
    expect(JSON.stringify(data)).not.toContain('encrypted')
  })
})
