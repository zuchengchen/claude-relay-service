jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
}))

jest.mock('axios', () => jest.fn())

const axios = require('axios')
const balanceScriptService = require('../src/services/balanceScriptService')

const scriptFor = (url) =>
  `({ request: { url: ${JSON.stringify(url)} }, extractor: function(){ return { remaining: 1 } } })`

describe('balanceScriptService', () => {
  const original = process.env.BALANCE_SCRIPT_ENABLED

  beforeEach(() => {
    process.env.BALANCE_SCRIPT_ENABLED = 'true'
    axios.mockReset()
  })

  afterEach(() => {
    if (original === undefined) {
      delete process.env.BALANCE_SCRIPT_ENABLED
    } else {
      process.env.BALANCE_SCRIPT_ENABLED = original
    }
  })

  it('is disabled unless BALANCE_SCRIPT_ENABLED=true', async () => {
    delete process.env.BALANCE_SCRIPT_ENABLED
    await expect(
      balanceScriptService.execute({ scriptBody: scriptFor('https://example.com/') })
    ).rejects.toThrow('余额脚本功能已禁用')
  })

  it.each([
    'http://[::1]:8080/',
    'http://[::ffff:127.0.0.1]/',
    'http://[fe80::1]/',
    'http://[fd12::1]/',
    'http://[::]/',
    'http://0x7f.0.0.1/',
    'http://169.254.169.254/latest/meta-data/'
  ])('rejects internal address %s', async (url) => {
    await expect(balanceScriptService.execute({ scriptBody: scriptFor(url) })).rejects.toThrow(
      '不安全'
    )
    expect(axios).not.toHaveBeenCalled()
  })

  it('allows public URLs and disables redirect following', async () => {
    axios.mockResolvedValue({ status: 200, headers: {}, data: {} })

    const result = await balanceScriptService.execute({
      scriptBody: scriptFor('https://api.example.com/balance')
    })

    expect(axios).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://api.example.com/balance', maxRedirects: 0 })
    )
    expect(result.mapped.balance).toBe(1)
  })
})
