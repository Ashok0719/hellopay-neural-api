const express = require('express');
const router = express.Router();
const { createOrder, verifyPayment, getWalletHistory, getPublicConfig, simulatePayment, requestWithdrawal } = require('../controllers/walletController');
const { protect } = require('../middleware/authMiddleware');

router.post('/add-money', protect, createOrder);
router.post('/verify-payment', protect, verifyPayment);
router.post('/simulate-payment', protect, simulatePayment);
router.post('/withdraw', protect, requestWithdrawal);
router.get('/history', protect, getWalletHistory);
router.get('/config', getPublicConfig);

module.exports = router;
