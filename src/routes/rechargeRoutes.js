const express = require('express');
const router = express.Router();
const { rechargeMobile, getRechargeHistory } = require('../controllers/rechargeController');
const { protect } = require('../middleware/authMiddleware');

router.post('/mobile', protect, rechargeMobile);
router.get('/history', protect, getRechargeHistory);

module.exports = router;
