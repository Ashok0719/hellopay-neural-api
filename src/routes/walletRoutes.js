const express = require('express');
const router = express.Router();
const { createOrder, verifyPayment, getWalletHistory, getPublicConfig, simulatePayment, requestWithdrawal, neuralVerifyPayment } = require('../controllers/walletController');
const { protect } = require('../middleware/authMiddleware');
const { upload } = require('../middleware/uploadMiddleware');

router.post('/add-money', protect, createOrder);
router.post('/verify-payment', protect, verifyPayment);
router.post('/neural-verify', protect, upload.single('screenshot'), neuralVerifyPayment);
router.post('/simulate-payment', protect, simulatePayment);
router.post('/withdraw', protect, requestWithdrawal);
router.get('/history', protect, getWalletHistory);
router.get('/config', getPublicConfig);

module.exports = router;
