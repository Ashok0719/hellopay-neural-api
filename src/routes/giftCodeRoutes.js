const express = require('express');
const router = express.Router();
const { claimGiftCode } = require('../controllers/giftCodeController');
const { protect } = require('../middleware/authMiddleware');

// User Routes
router.post('/claim', protect, claimGiftCode);

module.exports = router;
