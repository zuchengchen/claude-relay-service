// 管理端 Droid 路由：usage-windows 不能被 /droid-accounts/:id 截走；reset-status 路径与前端一致
const express = require('express')
const request = require('supertest')

jest.mock('../src/middleware/auth', () => ({
  authenticateAdmin: jest.fn((_req, _res, next) => next())
}))
jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn()
}))
jest.mock('../src/services/account/droidAccountService', () => ({
  getAccount: jest.fn(async () => null),
  resetAccountStatus: jest.fn(async (id) => ({ success: true, accountId: id }))
}))
jest.mock('../src/services/droidUsageWindowService', () => ({
  getUsageWindows: jest.fn(async () => ({}))
}))
jest.mock('../src/services/accountGroupService', () => ({}))
jest.mock('../src/services/apiKeyService', () => ({}))
jest.mock('../src/models/redis', () => ({}))
jest.mock('../src/utils/workosOAuthHelper', () => ({
  startDeviceAuthorization: jest.fn(),
  pollDeviceAuthorization: jest.fn(),
  WorkOSDeviceAuthError: class WorkOSDeviceAuthError extends Error {}
}))
jest.mock('../src/utils/webhookNotifier', () => ({
  sendAccountAnomalyNotification: jest.fn(async () => {})
}))

const droidAccountService = require('../src/services/account/droidAccountService')
const droidUsageWindowService = require('../src/services/droidUsageWindowService')
const droidAccountsRouter = require('../src/routes/admin/droidAccounts')

const app = express()
app.use(express.json())
app.use('/admin', droidAccountsRouter)

beforeEach(() => {
  jest.clearAllMocks()
})

describe('GET /admin/droid-accounts/usage-windows', () => {
  it('is not captured by /droid-accounts/:id and passes ids and force', async () => {
    droidUsageWindowService.getUsageWindows.mockResolvedValueOnce({
      a1: { windows: { sevenDay: { util: 50 } } }
    })

    const res = await request(app).get(
      '/admin/droid-accounts/usage-windows?accountIds=a1,%20a2,bad%20id!&force=1'
    )

    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      success: true,
      data: { a1: { windows: { sevenDay: { util: 50 } } } }
    })
    expect(droidUsageWindowService.getUsageWindows).toHaveBeenCalledWith(['a1', 'a2'], {
      force: true
    })
    expect(droidAccountService.getAccount).not.toHaveBeenCalled()
  })

  it('defaults to all accounts without force', async () => {
    const res = await request(app).get('/admin/droid-accounts/usage-windows')

    expect(res.status).toBe(200)
    expect(droidUsageWindowService.getUsageWindows).toHaveBeenCalledWith(null, { force: false })
  })

  it('returns an empty map when no valid id is given', async () => {
    const res = await request(app).get('/admin/droid-accounts/usage-windows?accountIds=,,')

    expect(res.body).toEqual({ success: true, data: {} })
    expect(droidUsageWindowService.getUsageWindows).not.toHaveBeenCalled()
  })

  it('reports failures in the standard error shape', async () => {
    droidUsageWindowService.getUsageWindows.mockRejectedValueOnce(new Error('redis down'))

    const res = await request(app).get('/admin/droid-accounts/usage-windows')

    expect(res.status).toBe(500)
    expect(res.body.error).toEqual(
      expect.objectContaining({ message: 'redis down', code: 'droid_usage_windows_failed' })
    )
  })
})

describe('POST /admin/droid-accounts/:accountId/reset-status', () => {
  it('matches the URL used by the admin SPA', async () => {
    const res = await request(app).post('/admin/droid-accounts/acct-1/reset-status')

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ success: true, data: { success: true, accountId: 'acct-1' } })
    expect(droidAccountService.resetAccountStatus).toHaveBeenCalledWith('acct-1')
  })
})
