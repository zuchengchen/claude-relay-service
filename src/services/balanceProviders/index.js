const DroidBalanceProvider = require('./droidBalanceProvider')

function registerAllProviders(balanceService) {
  balanceService.registerProvider('droid', new DroidBalanceProvider())
}

module.exports = { registerAllProviders }
