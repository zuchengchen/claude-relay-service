/**
 * 测试用的内存版 Redis（只实现本仓库 Droid 额度相关代码用到的命令）
 * 过期时间基于 Date.now()，测试里可以用 jest.spyOn(Date, 'now') 控制时间
 */
class FakeRedis {
  constructor() {
    this.strings = new Map()
    this.hashes = new Map()
    this.lists = new Map()
    this.expiry = new Map()
  }

  _alive(key) {
    const at = this.expiry.get(key)
    if (at !== undefined && at <= Date.now()) {
      this.strings.delete(key)
      this.hashes.delete(key)
      this.lists.delete(key)
      this.expiry.delete(key)
    }
  }

  _exists(key) {
    this._alive(key)
    return this.strings.has(key) || this.hashes.has(key) || this.lists.has(key)
  }

  async get(key) {
    this._alive(key)
    return this.strings.has(key) ? this.strings.get(key) : null
  }

  async set(key, value, ...args) {
    this._alive(key)
    const flags = args.map((arg) => (typeof arg === 'string' ? arg.toUpperCase() : arg))
    if (flags.includes('NX') && this.strings.has(key)) {
      return null
    }
    if (flags.includes('XX') && !this.strings.has(key)) {
      return null
    }
    this.strings.set(key, String(value))
    const pxIndex = flags.indexOf('PX')
    const exIndex = flags.indexOf('EX')
    if (pxIndex >= 0) {
      this.expiry.set(key, Date.now() + Number(flags[pxIndex + 1]))
    } else if (exIndex >= 0) {
      this.expiry.set(key, Date.now() + Number(flags[exIndex + 1]) * 1000)
    } else {
      this.expiry.delete(key)
    }
    return 'OK'
  }

  async del(...keys) {
    let removed = 0
    for (const key of keys.flat()) {
      if (this._exists(key)) {
        removed += 1
      }
      this.strings.delete(key)
      this.hashes.delete(key)
      this.lists.delete(key)
      this.expiry.delete(key)
    }
    return removed
  }

  async pttl(key) {
    if (!this._exists(key)) {
      return -2
    }
    const at = this.expiry.get(key)
    return at === undefined ? -1 : at - Date.now()
  }

  async expire(key, seconds) {
    if (!this._exists(key)) {
      return 0
    }
    this.expiry.set(key, Date.now() + Number(seconds) * 1000)
    return 1
  }

  async hget(key, field) {
    this._alive(key)
    const hash = this.hashes.get(key)
    return hash && hash.has(field) ? hash.get(field) : null
  }

  async hset(key, field, value) {
    this._alive(key)
    if (!this.hashes.has(key)) {
      this.hashes.set(key, new Map())
    }
    this.hashes.get(key).set(String(field), String(value))
    return 1
  }

  async hgetall(key) {
    this._alive(key)
    const hash = this.hashes.get(key)
    return hash ? Object.fromEntries(hash) : {}
  }

  async hdel(key, ...fields) {
    this._alive(key)
    const hash = this.hashes.get(key)
    if (!hash) {
      return 0
    }
    let removed = 0
    for (const field of fields.flat()) {
      if (hash.delete(String(field))) {
        removed += 1
      }
    }
    return removed
  }

  async ttl(key) {
    const ms = await this.pttl(key)
    return ms > 0 ? Math.ceil(ms / 1000) : ms
  }

  async lpush(key, ...values) {
    this._alive(key)
    const list = this.lists.get(key) || []
    values.forEach((value) => list.unshift(String(value)))
    this.lists.set(key, list)
    return list.length
  }

  // 与 Redis 一致：负数下标从尾部算起，stop 包含在内
  _range(list, start, stop) {
    const from = start < 0 ? Math.max(list.length + start, 0) : start
    const to = stop < 0 ? list.length + stop : stop
    return list.slice(from, to + 1)
  }

  async ltrim(key, start, stop) {
    this._alive(key)
    const list = this.lists.get(key) || []
    this.lists.set(key, this._range(list, start, stop))
    return 'OK'
  }

  async lrange(key, start, stop) {
    this._alive(key)
    return this._range(this.lists.get(key) || [], start, stop)
  }

  pipeline() {
    const ops = []
    const chain = {
      get: (key) => {
        ops.push(() => this.get(key))
        return chain
      },
      pttl: (key) => {
        ops.push(() => this.pttl(key))
        return chain
      },
      hgetall: (key) => {
        ops.push(() => this.hgetall(key))
        return chain
      },
      exec: async () => {
        const results = []
        for (const op of ops) {
          try {
            results.push([null, await op()])
          } catch (error) {
            results.push([error, null])
          }
        }
        return results
      }
    }
    return chain
  }
}

module.exports = FakeRedis
