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
  handleWebhook
} = require('../controllers/paymentController');

const { saveUpi } = require('../controllers/authController');

router.get('/',                          protect, getStocks);
router.post('/webhook',                  handleWebhook);
router.post('/generate-splits',          protect, generateVirtualSplits);
router.post('/select',                   protect, selectStock);
router.post('/cancel-selection',          protect, cancelSelection);
router.post('/buy',                      protect, buyStock);
router.post('/create-order',             protect, createStockOrder);
router.get('/transactions/:id',          protect, getTransaction);
router.post('/transactions/:transactionId/cancel', protect, cancelStockTransaction);
router.post('/transactions/:id/upload',  protect, upload.single('screenshot'), uploadPaymentScreenshot);

// Advanced Verification Module (Feature 9)
router.post('/save-upi', protect, upload.single('qrCode'), saveUpi);

// Neural Alert: Notify admin when user enters payment section
router.post('/notify-payment-entry', protect, async (req, res) => {
  try {
    const { amount, type } = req.body;
    const userName = req.user?.name || 'Unknown User';
    const userId = req.user?._id;

    // Broadcast to all admin clients via socket
    if (req.io) {
      req.io.emit('new_payment_session', {
        userName,
        userId,
        amount,
        type: type || 'stock_buy',
        timestamp: new Date().toISOString(),
        message: `${userName} has entered the payment section for ₹${amount}`
      });
      console.log(`[Neural Alert] Payment session started by ${userName} for ₹${amount}`);
    }

    res.json({ success: true, message: 'Admin notified' });
  } catch (err) {
    console.error('Notify payment entry error:', err);
    res.status(500).json({ success: false });
  }
});

module.exports = router;
