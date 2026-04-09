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
    const { transactionId, utr, timeSpent } = req.body;
    const file = req.file;

    if (!file) return res.status(400).json({ success: false, message: 'Screenshot required for automatic verification' });

    const stockTx = await StockTransaction.findById(transactionId);
    if (!stockTx) return res.status(404).json({ success: false, message: 'Transaction not found' });

    // 1. PERFORM OCR (50% WEIGHT)
    const ocrResult = await performOcr(file.path);
    let ocrScore = 0;
    
    const amountMatch = ocrResult.extractedAmount === stockTx.amount;
    const utrMatch = ocrResult.extractedUtr === utr;
    const isPaid = ocrResult.isSuccessFound;

    if (amountMatch && (utrMatch || isPaid)) ocrScore = 50;
    else if (isPaid || utrMatch) ocrScore = 30;

    // 2. TIME-BASED LOGIC (30% WEIGHT) - Feature 4 & 8
    let timeScore = 0;
    const t = Number(timeSpent) || 0;
    if (t > 30) timeScore = 30;
    else if (t >= 5 && t <= 25) timeScore = 20;
    else if (t < 3) timeScore = 0;

    // 3. UTR VALIDITY (20% WEIGHT) - Feature 7
    let utrScore = 0;
    const isUtrUnique = !(await Payment.findOne({ utr, transactionId: { $ne: transactionId } }));
    const isUtrFormatValid = /^\d{12,22}$/.test(utr || '');
    if (isUtrUnique && isUtrFormatValid) utrScore = 20;

    // 4. FINAL CALCULATION - Feature 8
    const totalScore = ocrScore + timeScore + utrScore;
    let finalStatus = 'pending';

    if (totalScore >= 80) finalStatus = 'success';
    else if (totalScore >= 60) finalStatus = 'suspicious'; // Marked for REVIEW
    else finalStatus = 'failed';

    // Find or create payment record
    let payment = await Payment.findOne({ transactionId: stockTx._id });
    if (!payment) {
        payment = new Payment({
            userId: req.user._id,
            transactionId: stockTx._id,
            amount: stockTx.amount
        });
    }

    payment.utr = utr || ocrResult.extractedUtr;
    payment.screenshotUrl = '/uploads/' + file.filename;
    payment.verificationMethod = 'OCR_AUTO';
    payment.fraudScore = 100 - totalScore; // Confidence Score inverted for fraud tracking
    payment.status = finalStatus;
    payment.ocrData = { extractedAmount: ocrResult.extractedAmount, extractedUtr: ocrResult.extractedUtr };
    
    await payment.save();

    if (finalStatus === 'success') {
        await finalizePayment(payment._id, 'success');
    }

    res.json({ 
        success: true, 
        status: finalStatus, 
        confidenceScore: totalScore,
        message: finalStatus === 'success' ? 'Fully Verified ✅' : 
                 finalStatus === 'suspicious' ? 'Under Review ⏳' : 'Verification Failed ❌'
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
