const express = require('express');
const router = express.Router();
const { createRazorpayOrder, verifyPayment } = require('../controllers/paymentController');
const { getWalletHistory, getPublicConfig, simulatePayment, requestWithdrawal, neuralVerifyPayment, matchP2P, verifySmsPayment } = require('../controllers/walletController');
const { protect } = require('../middleware/authMiddleware');
const { upload } = require('../middleware/uploadMiddleware');

router.post('/add-money', protect, createRazorpayOrder);
router.post('/match-p2p', protect, matchP2P);
router.post('/verify-payment', protect, verifyPayment);
router.post('/neural-verify', protect, upload.single('screenshot'), neuralVerifyPayment);
router.post('/verify-sms', verifySmsPayment); // Public for APK background listener
router.post('/simulate-payment', protect, simulatePayment);
router.post('/withdraw', protect, requestWithdrawal);
router.get('/history', protect, getWalletHistory);
router.get('/config', getPublicConfig);

module.exports = router;
