const express = require('express');
const router  = express.Router();
const { protect } = require('../middleware/authMiddleware');
const { upload }  = require('../middleware/uploadMiddleware');
const {
  getStocks,
  generateVirtualSplits,
  buyStock,
  selectStock,
  cancelSelection,
  createStockOrder,
  uploadPaymentScreenshot,
  cancelStockTransaction,
  getTransaction
} = require('../controllers/stockController');

const {
  verifyUtr,
  verifyScreenshot
} = require('../controllers/paymentController');

router.get('/',                          protect, getStocks);
router.post('/generate-splits',          protect, generateVirtualSplits);
router.post('/select',                   protect, selectStock);
router.post('/cancel-selection',          protect, cancelSelection);
router.post('/buy',                      protect, buyStock);
router.post('/create-order',             protect, createStockOrder);
router.get('/transactions/:id',          protect, getTransaction);
router.post('/transactions/:transactionId/cancel', protect, cancelStockTransaction);
router.post('/transactions/:id/upload',  protect, upload.single('screenshot'), uploadPaymentScreenshot);

// Advanced Verification Module (Feature 9)
router.post('/verify-utr', protect, verifyUtr);
router.post('/verify-screenshot', protect, upload.single('screenshot'), verifyScreenshot);

module.exports = router;
