const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const { initiateTransaction, callback, webhook, verifyPayment } = require('../controllers/paytmController');

router.post('/initiate', protect, initiateTransaction);
router.post('/callback', callback);
router.post('/webhook', webhook);
router.get('/verify', protect, verifyPayment);

module.exports = router;
