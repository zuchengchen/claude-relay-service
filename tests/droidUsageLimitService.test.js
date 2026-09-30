jest.mock('../src/models/redis', () => {
  const FakeRedis = require('./helpers/fakeRedis')
  const client = new FakeRedis()
  return { __fake: client, getClientSafe: jest.fn(() => client) }
})
jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn()
}))

const redis = require('../src/models/redis')
const service = require('../src/services/droidUsageLimitService')
const upstreamErrorHelper = require('../src/utils/upstreamErrorHelper')
const FakeRedis = require('./helpers/fakeRedis')

const HOUR = 3600 * 1000
const T0 = Date.UTC(2026, 8, 30, 4, 0, 0)
const ACCOUNT = { id: 'acct-1', name: 'bb6', disableAutoProtection: 'false' }
const TEMP_KEY = `temp_unavailable:droid:${ACCOUNT.id}`

let now
let dateNowSpy

beforeEach(() => {
  jest.clearAllMocks()
  const fresh = new FakeRedis()
  Object.assign(redis.__fake, {
    strings: fresh.strings,
    hashes: fresh.hashes,
    lists: fresh.lists,
    expiry: fresh.expiry
  })
  redis.getClientSafe.mockImplementation(() => redis.__fake)
  now = T0
  dateNowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now)
})

afterEach(() => {
  dateNowSpy.mockRestore()
})

describe('recordLimit / getActiveLimits / clearLimits', () => {
  it('stores the record with a TTL until resetAt', async () => {
    const record = await service.recordLimit(ACCOUNT.id, {
      window: 'fiveHour',
      resetAt: T0 + 2 * HOUR,
      detail: "You've reached your 5-hour standard usage limit"
    })

    expect(record).toEqual(
      expect.objectContaining({ window: 'fiveHour', resetAt: T0 + 2 * HOUR, source: '402' })
    )
    const key = service.limitKey(ACCOUNT.id, 'fiveHour')
    expect(await redis.__fake.pttl(key)).toBe(2 * HOUR)
    expect(JSON.parse(await redis.__fake.get(key))).toEqual({
      resetAt: T0 + 2 * HOUR,
      detail: "You've reached your 5-hour standard usage limit",
      source: '402',
      recordedAt: T0
    })

    expect(await service.getActiveLimits(ACCOUNT.id)).toEqual({
      fiveHour: expect.objectContaining({ resetAt: T0 + 2 * HOUR })
    })

    now = T0 + 2 * HOUR
    expect(await service.getActiveLimits(ACCOUNT.id)).toEqual({})
  })

  it('ignores expired limits and unknown windows', async () => {
    expect(await service.recordLimit(ACCOUNT.id, { window: 'fiveHour', resetAt: T0 })).toBeNull()
    expect(await service.recordLimit(ACCOUNT.id, { window: 'daily', resetAt: T0 + HOUR })).toBe(
      null
    )
    expect(await service.getActiveLimits(ACCOUNT.id)).toEqual({})
  })

  it('clears every window', async () => {
    await service.recordLimit(ACCOUNT.id, { window: 'fiveHour', resetAt: T0 + HOUR })
    await service.recordLimit(ACCOUNT.id, { window: 'sevenDay', resetAt: T0 + 100 * HOUR })

    expect(await service.clearLimits(ACCOUNT.id)).toBe(2)
    expect(await service.getActiveLimits(ACCOUNT.id)).toEqual({})
  })
})

describe('getSchedulingBlock', () => {
  it('blocks until the latest active limit', async () => {
    await service.recordLimit(ACCOUNT.id, { window: 'fiveHour', resetAt: T0 + HOUR })
    await service.recordLimit(ACCOUNT.id, { window: 'sevenDay', resetAt: T0 + 100 * HOUR })

    expect(await service.getSchedulingBlock(ACCOUNT)).toEqual({
      blocked: true,
      until: T0 + 100 * HOUR,
      reason: 'usage_limit',
      limits: [
        { window: 'fiveHour', resetAt: T0 + HOUR },
        { window: 'sevenDay', resetAt: T0 + 100 * HOUR }
      ]
    })
  })

  it('uses now + remaining TTL for temp_unavailable', async () => {
    await redis.__fake.set(TEMP_KEY, '{}', 'PX', 300 * 1000)
    now = T0 + 100 * 1000

    expect(await service.getSchedulingBlock(ACCOUNT)).toEqual(
      expect.objectContaining({ blocked: true, until: T0 + 300 * 1000, reason: 'temp_unavailable' })
    )
  })

  it('takes the later of temp_unavailable and the limit', async () => {
    await redis.__fake.set(TEMP_KEY, '{}', 'PX', 3 * HOUR)
    await service.recordLimit(ACCOUNT.id, { window: 'fiveHour', resetAt: T0 + HOUR })

    expect(await service.getSchedulingBlock(ACCOUNT)).toEqual(
      expect.objectContaining({ blocked: true, until: T0 + 3 * HOUR, reason: 'usage_limit' })
    )
  })

  it('ignores limits when auto protection is disabled, but still honours temp_unavailable', async () => {
    const unprotected = { ...ACCOUNT, disableAutoProtection: 'true' }
    await service.recordLimit(ACCOUNT.id, { window: 'sevenDay', resetAt: T0 + 100 * HOUR })

    expect(await service.getSchedulingBlock(unprotected)).toEqual(
      expect.objectContaining({ blocked: false, until: null })
    )

    await redis.__fake.set(TEMP_KEY, '{}', 'PX', 60 * 1000)
    expect(
      await service.getSchedulingBlock({ ...unprotected, disableAutoProtection: true })
    ).toEqual(expect.objectContaining({ blocked: true, reason: 'temp_unavailable' }))
  })

  it('self-heals a temp_unavailable key without TTL', async () => {
    await redis.__fake.set(TEMP_KEY, '{}')

    expect((await service.getSchedulingBlock(ACCOUNT)).blocked).toBe(false)
    await Promise.resolve()
    expect(await redis.__fake.get(TEMP_KEY)).toBeNull()
  })

  it('applies the same temp_unavailable rules as isTempUnavailable', async () => {
    const isTemp = () => upstreamErrorHelper.isTempUnavailable(ACCOUNT.id, 'droid')
    const blocked = async () => (await service.getSchedulingBlock(ACCOUNT)).blocked

    expect(upstreamErrorHelper.getTempUnavailableKey(ACCOUNT.id, 'droid')).toBe(TEMP_KEY)

    expect([await isTemp(), await blocked()]).toEqual([false, false])

    await redis.__fake.set(TEMP_KEY, '{}', 'PX', 60 * 1000)
    expect([await isTemp(), await blocked()]).toEqual([true, true])

    // 没有 TTL 的键：两边都视为可用并清理
    await redis.__fake.set(TEMP_KEY, '{}')
    expect(await isTemp()).toBe(false)
    expect(await redis.__fake.get(TEMP_KEY)).toBeNull()
    await redis.__fake.set(TEMP_KEY, '{}')
    expect(await blocked()).toBe(false)
    expect(await redis.__fake.get(TEMP_KEY)).toBeNull()
  })

  it('fails open when Redis is unavailable', async () => {
    redis.getClientSafe.mockImplementation(() => {
      throw new Error('Redis client is not connected')
    })

    expect(await service.getSchedulingBlock(ACCOUNT)).toEqual({
      blocked: false,
      until: null,
      reason: null,
      limits: []
    })
  })
})
