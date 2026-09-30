const GenericBalanceProvider = require('./genericBalanceProvider')

function registerAllProviders(balanceService) {
  balanceService.registerProvider('droid', new GenericBalanceProvider('droid'))
}

module.exports = { registerAllProviders }
