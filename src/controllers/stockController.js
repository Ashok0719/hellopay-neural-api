const Stock = require('../models/Stock');
const StockTransaction = require('../models/StockTransaction');
const User = require('../models/User');
const Config = require('../models/Config');
const Tesseract = require('tesseract.js');
const { auditUserBehavior } = require('../utils/fraudEngine');
const { findBestSplits, syncUserStocks } = require('../utils/financeLogic');

// Wrapper for controllers
const rebuildVirtualSplits = async (userId, walletBalance, config) => {
  return await syncUserStocks(User, Stock, userId, walletBalance, config);
};


/* ─────────────────────────────────────────────────────────────
   GET /api/stocks  — list all available stocks (excluding caller's)
   Frontend already filters by ownerId, but this gives cleaner UX
───────────────────────────────────────────────────────────── */
exports.getStocks = async (req, res) => {
  try {
    // Neural Expire: Unlock any selection that has timed out
    await Stock.updateMany(
      { status: 'LOCKED', selectionExpires: { $lt: new Date() } },
      { $set: { status: 'AVAILABLE', selectedBy: null, selectionExpires: null, lockedUntil: null } }
    );

    const stocks = await Stock.find({ 
      status: { $ne: 'SOLD' }
    })
      .populate('ownerId', 'name upiId qrCode userIdNumber isOpenSelling')
      .populate('selectedBy', 'name')
      .sort({ isPinned: -1, createdAt: -1 });

    // Feature: Marketplace Visibility (Neural Toggle)
    const filtered = stocks.filter(s => {
      // Always show if owner is verified or if owner has explicitly opened selling
      return s.ownerId && s.ownerId.isOpenSelling;
    });

    res.json({ success: true, stocks: filtered });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

/* ─────────────────────────────────────────────────────────────
   POST /api/stocks/select  — temporarily lock for 1 minute
───────────────────────────────────────────────────────────── */
exports.selectStock = async (req, res) => {
  try {
    const { stockId } = req.body;
    const user = req.user;

    const stock = await Stock.findById(stockId);
    if (!stock) return res.status(404).json({ success: false, message: 'Stock Node Not Found' });

    // Check if already locked by someone else
    if (stock.status === 'LOCKED' && 
        stock.selectedBy && 
        stock.selectedBy.toString() !== user._id.toString() && 
        stock.selectionExpires > new Date()) {
      return res.status(400).json({ 
        success: false, 
        message: 'This stock is already selected by another user',
        selectedBy: stock.selectedBy
      });
    }

    // Refresh/Create Selection Lock (1 Minute)
    stock.status = 'LOCKED';
    stock.selectedBy = user._id;
    stock.selectionExpires = new Date(Date.now() + 60 * 1000);
    stock.lockedUntil = stock.selectionExpires; 
    await stock.save();

    req.io.emit('stock_update', { action: 'refresh' });
    res.json({ success: true, message: 'Stock selected/locked for 1 minute', stock });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

/* ─────────────────────────────────────────────────────────────
   POST /api/stocks/cancel-selection
───────────────────────────────────────────────────────────── */
exports.cancelSelection = async (req, res) => {
  try {
    const { stockId } = req.body;
    const stock = await Stock.findOne({ _id: stockId, selectedBy: req.user._id });
    
    if (stock) {
      stock.status = 'AVAILABLE';
      stock.selectedBy = null;
      stock.selectionExpires = null;
      stock.lockedUntil = null;
      await stock.save();
      req.io.emit('stock_update', { action: 'refresh' });
    }
    
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

/* ─────────────────────────────────────────────────────────────
   POST /api/stocks/generate-splits
   Called on dashboard load — creates virtual units from wallet.
   Wallet balance is NOT deducted.
───────────────────────────────────────────────────────────── */
exports.generateVirtualSplits = async (req, res) => {
  try {
    const user   = await User.findById(req.user._id);
    const config = await Config.findOne({ key: 'SYSTEM_CONFIG' });

    // Temporary Override: Allowing token generation without Identity Signal (UPI)

    const created = await rebuildVirtualSplits(user._id, user.walletBalance, config);

    req.io.emit('stock_update', { action: 'splits_generated', userId: user._id });
    res.json({
      success:    true,
      message:    `Generated ${created.length} virtual split units`,
      splits:     created,
      walletBalance: user.walletBalance   // wallet stays untouched
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

/* ─────────────────────────────────────────────────────────────
   POST /api/stocks/buy  — initiate purchase (lock the unit)
───────────────────────────────────────────────────────────── */
exports.buyStock = async (req, res) => {
  try {
    const { stockId, pin } = req.body;
    const buyer = await User.findById(req.user._id);

    if (buyer.isBlocked) {
      return res.status(403).json({ success: false, message: 'Account suspended for behavioral anomalies' });
    }

    if (!pin) {
      return res.status(400).json({ success: false, message: 'Safety PIN required' });
    }

    if (!(await buyer.matchPin(pin))) {
      return res.status(401).json({ success: false, message: 'Safety Protocol: Invalid PIN' });
    }

    if (!buyer.upiId) {
      return res.status(400).json({ success: false, message: 'Please add your UPI ID before buying stock' });
    }

    const stock = await Stock.findOne({ 
      _id: stockId, 
      $or: [
        { status: 'AVAILABLE' },
        { status: 'LOCKED', selectedBy: req.user._id, selectionExpires: { $gt: new Date() } }
      ]
    }).populate('ownerId', 'name upiId qrCode');

    if (!stock) {
      return res.status(400).json({ success: false, message: 'Stock already selected by another user or session expired' });
    }

    // Self-purchase guard
    if (stock.ownerId._id.toString() === buyer._id.toString()) {
      auditUserBehavior(buyer._id, 'SELF_BUY_ATTEMPT', 50, req, 'User tried to buy own virtual split');
      return res.status(400).json({ success: false, message: 'Operation prohibited: Self-purchase detected' });
    }

    // Fraud audit
    auditUserBehavior(buyer._id, 'STOCK_BUY_INIT', 5, req, `Stock: ${stockId}`);

    // Lock virtual unit → RESERVED (Strict 20-minute Neural Window)
    stock.status      = 'LOCKED';
    stock.lockedUntil = new Date(Date.now() + 20 * 60 * 1000); 
    stock.selectionExpires = stock.lockedUntil;
    await stock.save();

    const transaction = await StockTransaction.create({
      transactionId: 'TXN' + Date.now() + Math.floor(Math.random() * 1000),
      stockId:       stock._id,
      buyerId:       buyer._id,
      sellerId:      stock.ownerId._id,
      amount:        stock.amount,
      status:        'INIT'
    });

    req.io.emit('stock_update', { action: 'locked', stockId: stock._id });

    res.json({ success: true, transaction, stock });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

/* ─────────────────────────────────────────────────────────────
   POST /api/stocks/create-order  — gateway order creation stub
───────────────────────────────────────────────────────────── */
exports.createStockOrder = async (req, res) => {
  try {
    const { stockId } = req.body;
    const buyer = await User.findById(req.user._id);

    if (buyer.isBlocked) {
      return res.status(403).json({ success: false, message: 'Account locked' });
    }

    const stock = await Stock.findOne({ _id: stockId, status: 'AVAILABLE' })
      .populate('ownerId', 'name upiId qrCode');
    if (!stock) return res.status(400).json({ success: false, message: 'Stock not available' });

    if (stock.ownerId._id.toString() === buyer._id.toString()) {
      return res.status(400).json({ success: false, message: 'Self-purchase forbidden' });
    }

    auditUserBehavior(buyer._id, 'ORDER_CREATE', 2, req, `Stock: ${stockId}`);

    const orderId = 'ORD_' + Date.now();
    res.json({
      success:   true,
      orderId,
      amount:    stock.amount,
      buyerName: buyer.name,
      ownerUpi:  stock.ownerId.upiId
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

/* ─────────────────────────────────────────────────────────────
   POST /api/stocks/transactions/:id/upload
   Upload payment screenshot → OCR verify → execute rotation.

   VIRTUAL SPLIT RULES:
   ① Wallet is NOT touched during split creation.
   ② Seller wallet is ONLY deducted after successful purchase.
   ③ Buyer wallet receives amount + profit% and is re-split.
   ④ Seller splits are recalculated from remaining balance.
───────────────────────────────────────────────────────────── */
const crypto = require('crypto');
const fs = require('fs');

/* ─────────────────────────────────────────────────────────────
   POST /api/stocks/transactions/:id/upload
   Enhanced AI OCR verification system for HelloPay Neural 2.0
───────────────────────────────────────────────────────────── */
exports.uploadPaymentScreenshot = async (req, res) => {
  try {
    const { id }  = req.params;
    const { utr } = req.body;
    const buyer   = req.user;
    const file    = req.file;

    // ── STRICT RULE: BOTH MUST EXIST ──
    if (!file || !utr) {
      return res.status(400).json({ success: false, message: 'Upload both UTR and screenshot' });
    }

    // ── STRICT RULE: UTR PATTERN (12 Digits) ──
    if (!/^\d{12}$/.test(utr.trim())) {
      return res.status(400).json({ success: false, message: 'Invalid UTR format. Must be 12 digits.' });
    }

    const transaction = await StockTransaction.findOne({ _id: id, buyerId: buyer._id, status: 'INIT', isProcessed: { $ne: true } })
      .populate('sellerId', 'upiId name');
      
    if (!transaction) {
      return res.status(400).json({ success: false, message: 'Invalid transaction flow. Please complete payment using Pay Now.' });
    }

    let confidenceScore = 0;
    let extractedData = { extractedAmount: 0, extractedUtr: null, extractedReceiver: null, extractedDate: null };
    let flagReasons = [];

    // ── 1. UTR VALIDATION (30%) ──
    const isUtrFormatValid = /^\d{12}$/.test(utr.trim());
    if (isUtrFormatValid) {
      confidenceScore += 15;
    } else {
      flagReasons.push('Invalid UTR Format');
    }

    const existingTxByUtr = await StockTransaction.findOne({ utr, _id: { $ne: id } });
    if (!existingTxByUtr) {
      confidenceScore += 15;
    } else {
      confidenceScore -= 50; 
      flagReasons.push('UTR duplicate detected');
    }

    // ── 2. SCREENSHOT REUSE (ANTI-FRAUD) ──
    let imageHash = null;
    if (fs.existsSync(file.path)) {
      const fileBuffer = fs.readFileSync(file.path);
      imageHash = require('crypto').createHash('md5').update(fileBuffer).digest('hex');
      
      const existingImg = await StockTransaction.findOne({ imageHash, _id: { $ne: id } });
      if (existingImg) {
        confidenceScore -= 40;
        flagReasons.push('Duplicate screenshot hash');
      }
    }

    // ── 3. TIME VALIDATION (10%) ──
    const txAge = Date.now() - new Date(transaction.createdAt).getTime();
    if (txAge <= 20 * 60 * 1000) { // 20 minutes limit
      confidenceScore += 10;
    } else {
      flagReasons.push('Payment session expired');
    }

    // ── 4. BEHAVIOR ANALYSIS (20%) ──
    let attemptScore = 0;
    try {
      const attemptCount = await StockTransaction.countDocuments({ buyerId: buyer._id, stockId: transaction.stockId });
      if (attemptCount <= 1) {
        confidenceScore += 10;
        attemptScore = 10;
      } else if (attemptCount >= 3) {
        confidenceScore -= 20;
        attemptScore = -20;
        flagReasons.push('Too many attempts');
      }

      const suspiciousCount = await StockTransaction.countDocuments({ buyerId: buyer._id, status: 'FRAUD_FLAGGED' });
      if (suspiciousCount === 0) {
        confidenceScore += 10;
      } else {
        confidenceScore -= 20;
        flagReasons.push('Suspicious patterns');
      }
    } catch (err) {
      console.warn("Behavior track error");
    }

    // ── 5. AI OCR ANALYSIS (40%) ──
    let amountScore = 0;
    let upiScore = 0;
    let successScore = 0;
    try {
      const result = await require('tesseract.js').recognize(file.path, 'eng');
      const text = result.data.text.toUpperCase();
      
      // Amount Extraction
      const expectedAmount = parseFloat(transaction.amount);
      const amountRegex = new RegExp(`\\b${expectedAmount}\\b|\\b${expectedAmount}\\.00\\b|\\b${expectedAmount.toLocaleString('en-IN')}\\b`);
      if (amountRegex.test(text)) {
         extractedData.extractedAmount = expectedAmount;
         confidenceScore += 15;
         amountScore = 15;
      } else {
         confidenceScore -= 30;
         amountScore = -30;
         flagReasons.push('Amount mismatch');
      }

      // UPI Extraction
      const sellerUpiIdPrefix = transaction.sellerId?.upiId?.split('@')[0]?.toUpperCase();
      if (sellerUpiIdPrefix && text.includes(sellerUpiIdPrefix)) {
         extractedData.extractedReceiver = transaction.sellerId.upiId;
         confidenceScore += 15;
         upiScore = 15;
      } else {
         confidenceScore -= 30;
         upiScore = -30;
         flagReasons.push('UPI mismatch');
      }

      // Success Status Extraction
      const successConfirmed = text.includes('SUCCESS') || text.includes('SUCCESSFUL') || text.includes('PAID TO');
      if (successConfirmed) {
         confidenceScore += 10;
         successScore = 10;
         extractedData.successConfirmed = true;
      } else {
         flagReasons.push('Visual success not confirmed');
      }

    } catch (ocrErr) {
      console.error('[Neural OCR] AI Analysis Failure:', ocrErr);
      flagReasons.push('OCR Engine Failure');
    }

    // BOUND CONFIDENCE SCORE 0-100
    confidenceScore = Math.max(0, Math.min(100, confidenceScore));

    transaction.utr = utr.trim();
    transaction.ocrData = { ...extractedData, flagReasons };
    transaction.imageHash = imageHash;
    transaction.screenshot = '/uploads/' + file.filename;
    transaction.confidenceScore = confidenceScore;
    
    // Determine Risk Level dynamically
    let riskLevel = 'High';
    if (confidenceScore >= 90) riskLevel = 'Low';
    else if (confidenceScore >= 70) riskLevel = 'Medium';
    transaction.ocrData.riskLevel = riskLevel;

    transaction.transparencyLogs = {
      scoreBreakdown: {
        utrFormat: isUtrFormatValid ? 15 : 0,
        utrUnique: !existingTxByUtr ? 15 : -50,
        timeValid: txAge <= 20 * 60 * 1000 ? 10 : 0,
        amountMatch: amountScore,
        upiMatch: upiScore,
        visualSuccess: successScore,
        behaviorAttempt: attemptScore,
        screenshotReuse: existingImg ? -40 : 0
      },
      validationResults: {
        extractedAmount: extractedData.extractedAmount,
        flags: flagReasons
      },
      decisionReason: riskLevel === 'Low' ? 'High confidence score' : (riskLevel === 'Medium' ? 'Manual review required' : 'Fraud flagged due to discrepancies')
    };

    // ── FINAL DECISION LOGIC ──
    if (confidenceScore < 70) {
      // HIGH RISK -> FRAUD FLAGGED
      transaction.status = 'FRAUD_FLAGGED';
      await transaction.save();
      
      // Release Stock
      const failedStock = await Stock.findById(transaction.stockId);
      if (failedStock) {
        failedStock.status = 'AVAILABLE';
        failedStock.lockedUntil = null;
        await failedStock.save();
      }
      if (req.io) req.io.emit('stock_update', { action: 'unlocked', stockId: transaction.stockId });

      try {
        const { auditUserBehavior } = require('../utils/fraudEngine');
        await auditUserBehavior(buyer._id, 'MULTIPLE_FRAUD_FLAGS', 20, req, `Score: ${confidenceScore}%. Reasons: ${flagReasons.join(', ')}`);
      } catch (e) {}
      
      const currentFraudCount = await StockTransaction.countDocuments({ buyerId: buyer._id, status: 'FRAUD_FLAGGED' });
      if (currentFraudCount >= 2) {
        const dbBuyer = await User.findById(buyer._id);
        if (dbBuyer) {
            dbBuyer.isBlocked = true;
            await dbBuyer.save();
        }
        return res.status(400).json({ success: false, message: 'Multiple suspicious activities detected' });
      }

      return res.status(400).json({ success: false, message: 'Verification failed due to mismatch' });
    }

    if (confidenceScore >= 70 && confidenceScore < 90) {
      // MEDIUM RISK -> REVIEW REQUIRED
      transaction.status = 'PENDING_REVIEW';
      await transaction.save();

      // Hook up to Admin Dashboard socket directly
      if (req.io) {
        req.io.emit('fraud_alert', {
          transactionId: transaction._id,
          buyer: buyer.name,
          score: confidenceScore,
          reasons: flagReasons
        });
      }

      return res.json({ success: true, message: 'Verification under review', confidenceScore });
    }

    // LOW RISK -> AUTO VERIFIED (>= 90%)
    transaction.status = 'SUCCESS';
    transaction.confidenceScore = confidenceScore;
    transaction.isProcessed = true;
    transaction.referenceId = `SECURE-TX-${Date.now()}`;
    await transaction.save();

    // ── ATOMIC SETTLEMENT PROCESS ──
    const soldStock = await Stock.findOneAndUpdate(
      { _id: transaction.stockId, status: { $ne: 'SOLD' } },
      { status: 'SOLD' },
      { new: true }
    );
    
    if (!soldStock) return res.status(400).json({ success: false, message: 'Fraud Prevented: Stock already sold or locked.' });

    const config = await Config.findOne({ key: 'SYSTEM_CONFIG' });
    const seller = await User.findById(transaction.sellerId);
    
    if (seller) {
      if (seller.walletBalance < transaction.amount) {
         await Stock.findByIdAndUpdate(transaction.stockId, { status: 'AVAILABLE' }); 
         return res.status(400).json({ success: false, message: 'Fail-Safe Triggered: Seller has insufficient balance. Transaction aborted.' });
      }
      seller.walletBalance = Number((seller.walletBalance - transaction.amount).toFixed(2));
      await seller.save();
      if (req.io) req.io.emit('userStatusChanged', { userId: seller._id, walletBalance: seller.walletBalance, updateMessage: 'Stock successfully sold.' });
    }

    const activeBuyer = await User.findById(buyer._id);
    const profitPercentage = config?.profitPercentage || 4;
    const profit = Number(((transaction.amount * profitPercentage) / 100).toFixed(2));

    activeBuyer.walletBalance = Number((activeBuyer.walletBalance + transaction.amount + profit).toFixed(2));
    activeBuyer.totalDeposited = Number(((activeBuyer.totalDeposited || 0) + transaction.amount).toFixed(2));
    await activeBuyer.save();

    if (activeBuyer.referredBy) {
      const referrer = await User.findById(activeBuyer.referredBy);
      if (referrer) {
        const commissionValue = Number((transaction.amount * 0.04).toFixed(2));
        referrer.walletBalance = Number((referrer.walletBalance + commissionValue).toFixed(2));
        referrer.referralEarnings = Number(((referrer.referralEarnings || 0) + commissionValue).toFixed(2));
        await referrer.save();
        if (req.io) req.io.emit('userStatusChanged', { userId: referrer._id, walletBalance: referrer.walletBalance });
      }
    }

    await rebuildVirtualSplits(seller._id, seller.walletBalance, config);
    await rebuildVirtualSplits(activeBuyer._id, activeBuyer.walletBalance, config);

    if (req.io) req.io.emit('stock_update', { action: 'rotation_complete' });
    return res.json({ success: true, message: 'Payment verified successfully', confidenceScore });

  } catch (err) {
    console.error('[Neural Critical Error]', err);
    res.status(500).json({ success: false, message: 'Internal Validation Exception' });
  }
};

/* ─────────────────────────────────────────────────────────────
   POST /api/stocks/transactions/:transactionId/cancel
───────────────────────────────────────────────────────────── */
exports.cancelStockTransaction = async (req, res) => {
  try {
    const { transactionId } = req.params;
    const transaction = await StockTransaction.findById(transactionId);

    if (!transaction) return res.status(404).json({ message: 'Transaction not found' });
    if (transaction.buyerId.toString() !== req.user._id.toString()) return res.status(403).json({ message: 'Neural Protocol: Unauthorized cancellation attempt' });
    if (transaction.status !== 'INIT') return res.status(400).json({ message: 'Only active transactions can be cancelled' });

    transaction.status = 'CANCELLED';
    await transaction.save();

    // Release the stock
    const stock = await Stock.findById(transaction.stockId);
    if (stock) {
      stock.status = 'AVAILABLE';
      stock.selectedBy = null;
      stock.selectionExpires = null;
      stock.lockedUntil = null;
      await stock.save();
    }

    req.io.emit('stock_update', { action: 'refresh' });
    res.json({ success: true, message: 'Transaction cancelled' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.getTransaction = async (req, res) => {
  try {
    const transaction = await StockTransaction.findById(req.params.id)
      .populate('sellerId', 'name upiId qrCode');
    if (!transaction) return res.status(404).json({ success: false, message: 'Node not found' });
    res.json({ success: true, transaction });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
