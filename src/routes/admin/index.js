/**
 * Admin Routes — Droid-only sidecar
 */

const express = require('express')
const router = express.Router()

const apiKeysRoutes = require('./apiKeys')
const accountGroupsRoutes = require('./accountGroups')
const droidAccountsRoutes = require('./droidAccounts')
const dashboardRoutes = require('./dashboard')
const usageStatsRoutes = require('./usageStats')
const accountBalanceRoutes = require('./accountBalance')
const systemRoutes = require('./system')
const concurrencyRoutes = require('./concurrency')
const errorHistoryRoutes = require('./errorHistory')
const requestDetailsRoutes = require('./requestDetails')

router.use('/', apiKeysRoutes)
router.use('/', droidAccountsRoutes)
router.use('/', dashboardRoutes)
router.use('/', usageStatsRoutes)
router.use('/', accountBalanceRoutes)
router.use('/', systemRoutes)
router.use('/', concurrencyRoutes)
router.use('/', errorHistoryRoutes)
router.use('/', requestDetailsRoutes)
router.use('/account-groups', accountGroupsRoutes)

module.exports = router
