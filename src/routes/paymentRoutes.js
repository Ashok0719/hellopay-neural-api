const express = require('express');
const router = express.Router();
const { createRazorpayOrder, verifyPayment, handleWebhook, submitPaymentProof, approvePayment, rejectPayment } = require('../controllers/paymentController');
const { protect } = require('../middleware/authMiddleware');
const { upload } = require('../middleware/uploadMiddleware');

// Unified Razorpay Core Routes
router.post('/create-razorpay-order', protect, createRazorpayOrder);
router.post('/verify-payment', protect, verifyPayment);
router.post('/razorpay-webhook', handleWebhook); // Public for Razorpay delivery

// Manual Verification Module
router.post('/submit-proof', protect, upload.single('screenshot'), submitPaymentProof);
router.post('/preview-proof', protect, upload.single('screenshot'), async (req, res) => {
  try {
    const { transactionId, humanId } = req.body;
    if (!req.file || !transactionId) return res.status(400).json({ success: false });

    const previewUrl = `/uploads/${req.file.filename}`;
    
    // Notify Admin LIVE with dual-matching signals
    if (req.io) {
      req.io.emit('payment_proof_preview', {
        transactionId,
        humanId,
        previewUrl,
        userId: req.user._id
      });
    }

    res.json({ success: true, previewUrl });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});
router.post('/approve/:id', protect, approvePayment); // Add admin-protect here in production
router.post('/reject/:id', protect, rejectPayment);

module.exports = router;
