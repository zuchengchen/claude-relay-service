jest.mock('../src/models/redis', () => {
  const FakeRedis = require('./helpers/fakeRedis')
  const client = new FakeRedis()
  return {
    __fake: client,
    getClientSafe: () => client,
    getSessionAccountMapping: jest.fn(async () => null),
    setSessionAccountMapping: jest.fn(async () => 'OK'),
    extendSessionAccountMappingTTL: jest.fn(async () => 1),
    deleteSessionAccountMapping: jest.fn(async () => 1)
  }
})
jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn()
}))
// 真实的 droidAccountService 构造函数里有 setInterval，整体 mock
jest.mock('../src/services/account/droidAccountService', () => ({
  getAccount: jest.fn(),
  getSchedulableAccounts: jest.fn(async () => []),
  touchLastUsedAt: jest.fn(async () => {})
}))
jest.mock('../src/services/accountGroupService', () => ({
  getGroupMembers: jest.fn(async () => [])
}))

const redis = require('../src/models/redis')
const droidAccountService = require('../src/services/account/droidAccountService')
const accountGroupService = require('../src/services/accountGroupService')
const droidUsageLimitService = require('../src/services/droidUsageLimitService')
const droidScheduler = require('../src/services/scheduler/droidScheduler')
const FakeRedis = require('./helpers/fakeRedis')

const { DroidAccountsExhaustedError } = droidScheduler

const HOUR = 3600 * 1000
const T0 = Date.UTC(2026, 8, 30, 4, 0, 0)

const makeAccount = (id, overrides = {}) => ({
  id,
  name: id,
  isActive: 'true',
  schedulable: 'true',
  status: 'active',
  endpointType: 'anthropic',
  priority: 50,
  disableAutoProtection: 'false',
  ...overrides
})

const limitAccount = (id, window, resetAt) =>
  droidUsageLimitService.recordLimit(id, { window, resetAt, detail: 'limit' })

const markTemp = (id, ttlMs) => redis.__fake.set(`temp_unavailable:droid:${id}`, '{}', 'PX', ttlMs)

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
  droidAccountService.getSchedulableAccounts.mockResolvedValue([])
  accountGroupService.getGroupMembers.mockResolvedValue([])
  now = T0
  dateNowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now)
})

afterEach(() => {
  dateNowSpy.mockRestore()
})

describe('droidScheduler.selectAccount with usage limits', () => {
  it('skips accounts with an active usage limit', async () => {
    droidAccountService.getSchedulableAccounts.mockResolvedValue([
      makeAccount('limited', { priority: 1 }),
      makeAccount('free', { priority: 50 })
    ])
    await limitAccount('limited', 'fiveHour', T0 + 2 * HOUR)

    const selected = await droidScheduler.selectAccount({ id: 'key-1' }, 'anthropic', null)

    expect(selected.id).toBe('free')
  })

  it('throws DroidAccountsExhaustedError with the earliest resetAt when all are temporal', async () => {
    droidAccountService.getSchedulableAccounts.mockResolvedValue([
      makeAccount('weekly'),
      makeAccount('five-hour'),
      makeAccount('temp')
    ])
    await limitAccount('weekly', 'sevenDay', T0 + 100 * HOUR)
    // 同时有 5h 和 7d 限额时，账号要等到较晚的那个
    await limitAccount('five-hour', 'fiveHour', T0 + 2 * HOUR)
    await limitAccount('five-hour', 'sevenDay', T0 + 50 * HOUR)
    await markTemp('temp', 5 * 60 * 1000)

    const error = await droidScheduler
      .selectAccount({ id: 'key-1' }, 'anthropic', null)
      .catch((e) => e)

    expect(error).toBeInstanceOf(DroidAccountsExhaustedError)
    expect(error.code).toBe('DROID_ACCOUNTS_EXHAUSTED')
    expect(error.resetAt).toBe(T0 + 5 * 60 * 1000)
    expect(error.exclusions).toHaveLength(3)
  })

  it('keeps the original error when accounts are excluded only for non-temporal reasons', async () => {
    droidAccountService.getSchedulableAccounts.mockResolvedValue([
      makeAccount('broken', { status: 'error' }),
      makeAccount('paused', { schedulable: 'false' })
    ])

    const error = await droidScheduler
      .selectAccount({ id: 'key-1' }, 'anthropic', null)
      .catch((e) => e)

    expect(error).not.toBeInstanceOf(DroidAccountsExhaustedError)
    expect(error.message).toBe('No available accounts for endpoint anthropic')
  })

  it('ignores unhealthy accounts when computing the reset time', async () => {
    droidAccountService.getSchedulableAccounts.mockResolvedValue([
      makeAccount('broken', { status: 'error' }),
      makeAccount('limited')
    ])
    // 不健康账号即使有更早的限额记录，也不参与恢复时间计算
    await limitAccount('broken', 'fiveHour', T0 + HOUR)
    await limitAccount('limited', 'fiveHour', T0 + 3 * HOUR)

    const error = await droidScheduler
      .selectAccount({ id: 'key-1' }, 'anthropic', null)
      .catch((e) => e)

    expect(error).toBeInstanceOf(DroidAccountsExhaustedError)
    expect(error.resetAt).toBe(T0 + 3 * HOUR)
    expect(error.exclusions.map((item) => item.accountId)).toEqual(['limited'])
  })

  it('does not exclude accounts with disableAutoProtection', async () => {
    droidAccountService.getSchedulableAccounts.mockResolvedValue([
      makeAccount('unprotected', { disableAutoProtection: 'true' })
    ])
    await limitAccount('unprotected', 'sevenDay', T0 + 100 * HOUR)

    const selected = await droidScheduler.selectAccount({ id: 'key-1' }, 'anthropic', null)

    expect(selected.id).toBe('unprotected')
  })

  it('falls back to the pool when the dedicated account is limited', async () => {
    const bound = makeAccount('bound')
    droidAccountService.getAccount.mockResolvedValue(bound)
    droidAccountService.getSchedulableAccounts.mockResolvedValue([bound, makeAccount('pool')])
    await limitAccount('bound', 'fiveHour', T0 + HOUR)

    const selected = await droidScheduler.selectAccount(
      { id: 'key-1', droidAccountId: 'bound' },
      'anthropic',
      null
    )

    expect(droidAccountService.getAccount).toHaveBeenCalledWith('bound')
    expect(selected.id).toBe('pool')
  })

  it('counts limited group members toward the reset time after falling back to the pool', async () => {
    accountGroupService.getGroupMembers.mockResolvedValue(['member'])
    droidAccountService.getAccount.mockResolvedValue(makeAccount('member'))
    await limitAccount('member', 'fiveHour', T0 + HOUR)

    const error = await droidScheduler
      .selectAccount({ id: 'key-1', droidAccountId: 'group:g1' }, 'anthropic', null)
      .catch((e) => e)

    expect(error).toBeInstanceOf(DroidAccountsExhaustedError)
    expect(error.resetAt).toBe(T0 + HOUR)
  })

  it('does not use an unusable bound account for the reset time', async () => {
    // 绑定账号本身不可用（error）且带着更早的限额：不应决定 429 的恢复时间
    droidAccountService.getAccount.mockResolvedValue(makeAccount('bound', { status: 'error' }))
    await limitAccount('bound', 'fiveHour', T0 + HOUR)

    const noPool = await droidScheduler
      .selectAccount({ id: 'key-1', droidAccountId: 'bound' }, 'anthropic', null)
      .catch((e) => e)
    expect(noPool).not.toBeInstanceOf(DroidAccountsExhaustedError)
    expect(noPool.message).toBe('No available accounts for endpoint anthropic (respecting binding)')

    droidAccountService.getSchedulableAccounts.mockResolvedValue([makeAccount('limited')])
    await limitAccount('limited', 'fiveHour', T0 + 3 * HOUR)
    const withPool = await droidScheduler
      .selectAccount({ id: 'key-1', droidAccountId: 'bound' }, 'anthropic', null)
      .catch((e) => e)
    expect(withPool).toBeInstanceOf(DroidAccountsExhaustedError)
    expect(withPool.resetAt).toBe(T0 + 3 * HOUR)
    expect(withPool.exclusions.map((item) => item.accountId)).toEqual(['limited'])
  })

  it('does not use endpoint-mismatched group members for the reset time', async () => {
    accountGroupService.getGroupMembers.mockResolvedValue(['comm-member'])
    droidAccountService.getAccount.mockResolvedValue(
      makeAccount('comm-member', { endpointType: 'comm' })
    )
    droidAccountService.getSchedulableAccounts.mockResolvedValue([makeAccount('limited')])
    await limitAccount('comm-member', 'fiveHour', T0 + HOUR)
    await limitAccount('limited', 'fiveHour', T0 + 3 * HOUR)

    const error = await droidScheduler
      .selectAccount({ id: 'key-1', droidAccountId: 'group:g1' }, 'anthropic', null)
      .catch((e) => e)

    expect(error).toBeInstanceOf(DroidAccountsExhaustedError)
    expect(error.resetAt).toBe(T0 + 3 * HOUR)
  })

  it('selects again once the limit has expired', async () => {
    droidAccountService.getSchedulableAccounts.mockResolvedValue([makeAccount('limited')])
    await limitAccount('limited', 'fiveHour', T0 + HOUR)

    now = T0 + HOUR + 1
    const selected = await droidScheduler.selectAccount({ id: 'key-1' }, 'anthropic', null)
    expect(selected.id).toBe('limited')
  })
})
