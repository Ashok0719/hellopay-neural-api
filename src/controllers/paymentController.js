const StockTransaction = require('../models/StockTransaction');
const Payment = require('../models/Payment');
const User = require('../models/User');
const { performOcr } = require('../utils/ocr');

/**
 * FEATURE 2: UTR PRIMARY VERIFICATION
 */
exports.verifyUtr = async (req, res) => {
  try {
    const { utr, transactionId } = req.body;
    const userId = req.user._id;

    if (!utr || !/^\d{12,22}$/.test(utr)) {
      return res.status(400).json({ success: false, message: 'Invalid UTR format (12-22 digits required)' });
    }

    // Prevent duplicate UTR
    const existing = await Payment.findOne({ utr });
    if (existing) {
      return res.status(400).json({ success: false, message: 'This UTR has already been used' });
    }

    const stockTx = await StockTransaction.findById(transactionId);
    if (!stockTx) return res.status(404).json({ success: false, message: 'Transaction not found' });

    // Create Payment Record
    const payment = await Payment.create({
      userId,
      transactionId: stockTx._id,
      amount: stockTx.amount,
      utr,
      status: 'pending',
      verificationMethod: 'UTR'
    });

    /**
     * FEATURE 4: AUTO DECISION (UTR ONLY VALID)
     * If user provided UTR and it's valid/unique, we can mark success (Phase 1)
     * Note: In a real production environment, you might wait for Screenshot or Bank API.
     * But per your Feature 4: "If Only UTR valid → SUCCESS (skip screenshot)"
     */
    const result = await finalizePayment(payment._id, 'success');

    res.json({ 
      success: true, 
      status: result.status, 
      message: 'UTR verified and balance updated' 
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * FEATURE 3: SCREENSHOT OCR VERIFICATION
 */
exports.verifyScreenshot = async (req, res) => {
  try {
    const { transactionId, utr } = req.body;
    const file = req.file;

    if (!file) return res.status(400).json({ success: false, message: 'Screenshot required' });

    const stockTx = await StockTransaction.findById(transactionId);
    if (!stockTx) return res.status(404).json({ success: false, message: 'Transaction not found' });

    // Perform OCR
    const ocrResult = await performOcr(file.path);
    
    // Find existing payment or create one
    let payment = await Payment.findOne({ transactionId: stockTx._id });
    if (!payment) {
        payment = new Payment({
            userId: req.user._id,
            transactionId: stockTx._id,
            amount: stockTx.amount,
            utr: utr || ocrResult.extractedUtr
        });
    }

    payment.screenshotUrl = '/uploads/' + file.filename;
    payment.verificationMethod = 'OCR';
    payment.ocrData = {
        extractedAmount: ocrResult.extractedAmount,
        extractedUtr: ocrResult.extractedUtr,
        matchStatus: (ocrResult.extractedUtr === utr) || (ocrResult.isSuccessFound)
    };

    /**
     * FEATURE 4: AUTO DECISION ENGINE
     */
    let finalStatus = 'pending';
    let fraudScore = 0;

    const amountMatch = ocrResult.extractedAmount === stockTx.amount;
    const utrMatch = ocrResult.extractedUtr === utr;

    if (amountMatch && utrMatch && ocrResult.isSuccessFound) {
        finalStatus = 'success';
    } else if (ocrResult.isSuccessFound || utrMatch) {
        finalStatus = 'success'; // Per logic: UTR valid is enough
    } else {
        finalStatus = 'suspicious';
        fraudScore = 50;
    }

    payment.status = finalStatus;
    payment.fraudScore = fraudScore;
    await payment.save();

    if (finalStatus === 'success') {
        await finalizePayment(payment._id, 'success');
    }

    res.json({ 
        success: true, 
        status: finalStatus, 
        ocr: ocrResult,
        message: finalStatus === 'success' ? 'Auto-verified via OCR' : 'Marked as suspicious for review'
    });

  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * FEATURE 6: WALLET INTEGRATION (Unified Helper)
 */
async function finalizePayment(paymentId, status) {
  const payment = await Payment.findById(paymentId);
  if (payment.status === 'success' && status === 'success') return payment;

  payment.status = status;
  await payment.save();

  if (status === 'success') {
    // 1. Update User Wallet
    const user = await User.findById(payment.userId);
    user.walletBalance += payment.amount;
    await user.save();

    // 2. Update Stock Transaction
    await StockTransaction.findByIdAndUpdate(payment.transactionId, { 
        status: 'SUCCESS',
        isProcessed: true
    });
  }

  return payment;
}
