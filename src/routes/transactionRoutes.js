const express = require('express');
const router = express.Router();
const { transferMoney, getTransactionHistory } = require('../controllers/transactionController');
const { protect } = require('../middleware/authMiddleware');
const { transferValidation } = require('../middleware/validator');

router.post('/transfer', protect, transferValidation, transferMoney);
router.get('/history', protect, getTransactionHistory);

module.exports = router;
