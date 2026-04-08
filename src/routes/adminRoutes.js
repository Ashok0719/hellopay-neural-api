const express = require('express');
const router = express.Router();
const User = require('../models/User');

const { 
  getAnalytics, 
  getAllUsers, 
  toggleUserBlock, 
  deleteUser,
  getConfig, 
  updateConfig, 
  getAllTransactions, 
  reviewTransaction,
  updateUserBalance,
  initializeStock,
  adminVerifyStockTransaction,
  getAllStocks,
  toggleStockPin,
  deleteStock,
  deleteTransaction,
  resplitUserWallet,
  overrideWalletSplits,
  getFraudDashboard
} = require('../controllers/adminController');

// Development bypass for admin dashboard since it lacks auth token logic
const bypassAdmin = async (req, res, next) => {
  let adminUser = await User.findOne({ role: 'admin' });
  if (!adminUser) {
    adminUser = await User.findOne(); // Fallback to any user
  }
  req.user = adminUser || { _id: 'mock_admin', role: 'admin', upiId: 'admin@okaxis', qrCode: '' };
  next();
};

router.get('/analytics', bypassAdmin, getAnalytics);
router.get('/users', bypassAdmin, getAllUsers);
router.put('/user/:id/block', bypassAdmin, toggleUserBlock);
router.delete('/user/:id', bypassAdmin, deleteUser);
router.put('/user/:id/balance', bypassAdmin, updateUserBalance);
router.get('/config', bypassAdmin, getConfig);
router.put('/config', bypassAdmin, updateConfig);
router.get('/transactions', bypassAdmin, getAllTransactions);
router.post('/transactions/:id/:action', bypassAdmin, reviewTransaction);
router.delete('/transactions/:id', bypassAdmin, deleteTransaction);
router.get('/stocks/list', bypassAdmin, getAllStocks);
router.put('/stocks/:id/pin', bypassAdmin, toggleStockPin);
router.post('/stocks', bypassAdmin, initializeStock);
router.delete('/stocks/:id', bypassAdmin, deleteStock);
router.post('/user/:id/resplit', bypassAdmin, resplitUserWallet);
router.post('/user/:id/override-splits', bypassAdmin, overrideWalletSplits);
router.get('/fraud-dashboard', bypassAdmin, getFraudDashboard);
router.put('/users/:id/percents', bypassAdmin, updateUserPercents);

module.exports = router;
