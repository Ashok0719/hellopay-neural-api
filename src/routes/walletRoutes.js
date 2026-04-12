const express = require('express');
const router = express.Router();
const { createOrder, fastringCallback, getWalletHistory, getPublicConfig, simulatePayment, requestWithdrawal, neuralVerifyPayment, matchP2P, verifySmsPayment } = require('../controllers/walletController');
const { protect } = require('../middleware/authMiddleware');
const { upload } = require('../middleware/uploadMiddleware');

router.post('/create-fastring-payment', protect, createOrder);
router.post('/fastring-callback', fastringCallback);
router.post('/add-money', protect, createOrder);
router.post('/match-p2p', protect, matchP2P);
router.post('/verify-payment', protect, fastringCallback);
router.post('/neural-verify', protect, upload.single('screenshot'), neuralVerifyPayment);
router.post('/verify-sms', verifySmsPayment); // Public for APK background listener
router.post('/simulate-payment', protect, simulatePayment);
router.post('/withdraw', protect, requestWithdrawal);
router.get('/history', protect, getWalletHistory);
router.get('/config', getPublicConfig);

module.exports = router;
