const express = require('express');
const router = express.Router();
const { 
    generateGiftCode, 
    getGiftCodes, 
    claimGiftCode, 
    deleteGiftCode 
} = require('../controllers/giftCodeController');
const { protect } = require('../middleware/authMiddleware');

// Admin Routes (Add admin check in production)
router.post('/generate', protect, generateGiftCode);
router.get('/', protect, getGiftCodes);
router.delete('/:id', protect, deleteGiftCode);

// User Routes
router.post('/claim', protect, claimGiftCode);

module.exports = router;
