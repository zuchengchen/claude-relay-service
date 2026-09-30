/**
 * 服务倍率存根（Droid sidecar 固定 1x）
 */
class ServiceRatesService {
  getService(_accountType, _model) {
    return 'droid'
  }

  async getServiceRate(_service) {
    return 1
  }
}

module.exports = new ServiceRatesService()
