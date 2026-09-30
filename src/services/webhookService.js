const logger = require('../utils/logger')

class WebhookService {
  async sendNotification(type, payload) {
    logger.debug(`webhook skipped (${type})`, payload?.accountId || '')
  }

  async testWebhook() {
    return { success: false, message: 'webhooks removed in Droid sidecar' }
  }
}

module.exports = new WebhookService()
