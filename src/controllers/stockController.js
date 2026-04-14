const Stock = require('../models/Stock');
const StockTransaction = require('../models/StockTransaction');
const User = require('../models/User');
const Config = require('../models/Config');
const Tesseract = require('tesseract.js');
const crypto = require('crypto');
const Razorpay = require('razorpay');
const Transaction = require('../models/Transaction');
const { auditUserBehavior } = require('../utils/fraudEngine');
const { findBestSplits, syncUserStocks, executeStockRotation, executeWalletRecharge } = require('../utils/financeLogic');

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
      status: 'AVAILABLE'
    })
      .populate('ownerId', 'name upiId qrCode userIdNumber isOpenSelling')
      .populate('selectedBy', 'name')
      .sort({ isPinned: -1, createdAt: 1 }); // Pinned First, then FIFO

    // Neural Self-Healing: Shorten legacy long IDs in the pool
    for (const s of stocks) {
      if (s.stockId.length > 8) {
         const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
         let newId = '';
         for (let j = 0; j < 5; j++) newId += chars.charAt(Math.floor(Math.random() * chars.length));
         s.stockId = newId;
         await s.save().catch(e => console.error('Healing failed:', e));
      }
    }

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

    // Atomic Neural Lock (FIFO Concurrency Control)
    const selectionExpires = new Date(Date.now() + 60 * 1000);
    const lockedStock = await Stock.findOneAndUpdate(
      { 
        _id: stockId, 
        status: 'AVAILABLE'
      },
      { 
        $set: { 
          status: 'LOCKED', 
          selectedBy: user._id, 
          selectionExpires: selectionExpires,
          lockedUntil: selectionExpires 
        } 
      },
      { new: true }
    );
    
    if (!lockedStock) {
      return res.status(400).json({ 
        success: false, 
        message: 'This stock node has just been claimed by another user in the queue' 
      });
    }

    req.io.emit('stock_update', { action: 'refresh' });
    res.json({ success: true, message: 'Neural position secured for 60 seconds', stock: lockedStock });
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

    // Enforce Identity Signal (UPI) for split generation
    if (!user.upiId) {
      return res.status(400).json({ success: false, message: 'Identity Signal missing: Please bind a UPI ID to generate virtual assets.' });
    }

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

    if (!buyer.upiId) {
      return res.status(400).json({ success: false, message: 'Please add your UPI ID before buying stock' });
    }

    // PIN Authentication Protocol
    if (!pin || !(await buyer.matchPin(pin))) {
      return res.status(401).json({ success: false, message: 'Safety Protocol: Invalid Security PIN' });
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

    // Neural 2.0: Clean Amount Protocal (Strict 100s multiple as per User Requirement)
    const expectedAmount = stock.amount;

    const transaction = await StockTransaction.create({
      transactionId: 'TXN' + Date.now() + Math.floor(Math.random() * 1000),
      stockId:       stock._id,
      buyerId:       buyer._id,
      sellerId:      stock.ownerId._id,
      amount:        expectedAmount,
      referenceUpi:  stock.ownerId.upiId, // Store for OCR validation
      status:        'PENDING_PAYMENT'
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

    const rzpOrder = await razorpay.orders.create({
      amount: stock.amount * 100, // amount in paise
      currency: "INR",
      receipt: 'order_rcptid_' + Date.now()
    });

    // Create a transaction record linked to this Razorpay Order
    const transaction = await StockTransaction.create({
       transactionId: 'TXN' + Date.now() + Math.floor(Math.random() * 1000),
       stockId: stock._id,
       buyerId: buyer._id,
       sellerId: stock.ownerId._id,
       amount: stock.amount,
       razorpayOrderId: rzpOrder.id,
       status: 'PENDING_PAYMENT'
    });

    // Lock the stock temporarily (LOCKED state)
    stock.status = 'LOCKED';
    stock.selectionExpires = new Date(Date.now() + 20 * 60 * 1000); // 20 min lock
    await stock.save();

    res.json({
      success: true,
      order: rzpOrder,
      transactionId: transaction._id,
      amount: stock.amount,
      key: process.env.RAZORPAY_KEY_ID,
      buyerName: buyer.name,
      buyerEmail: buyer.email || `${buyer.userIdNumber}@hellopay.io`
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
const fs = require('fs');

const cleanUTR = (str) => {
  if (!str) return '';
  return str.toString().replace(/[^a-zA-Z0-9]/g, '').toUpperCase().trim();
};

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

    // ── FEATURE: QUICK SETTLEMENT (Requirement: Allow UTR-only) ──
    if (!utr) {
      return res.status(400).json({ success: false, message: 'Neural Fault: UTR signal required for verification.' });
    }

    // ── STRICT RULE: UTR PATTERN (12 Digits) ──
    const userUtr = utr.trim();
    if (!/^\d{12}$/.test(userUtr)) {
      // Feature: Instant Recovery (Requirement: Stock again visible)
      const tx = await StockTransaction.findOne({ _id: id, buyerId: buyer._id, status: 'PENDING_PAYMENT' });
      if (tx) {
         tx.status = 'FAILED';
         tx.utr = userUtr;
         tx.ocrData = { flagReasons: ['Neural Rejection: Invalid UTR Format'] };
         await tx.save();
         await Stock.findByIdAndUpdate(tx.stockId, { status: 'AVAILABLE' });
      }
      return res.status(400).json({ success: false, message: 'PAYMENT FAILED: Invalid Signal Format.' });
    }

    const transaction = await StockTransaction.findOne({ _id: id, buyerId: buyer._id, status: 'PENDING_PAYMENT', isProcessed: { $ne: true } })
      .populate('sellerId', 'upiId name');
      
    if (!transaction) {
      return res.status(400).json({ success: false, message: 'Invalid transaction node. Signal expected: PENDING_PAYMENT' });
    }

    let confidenceScore = 0;
    let extractedData = { extractedAmount: 0, extractedUtr: null, extractedReceiver: null, extractedDate: null };
    let flagReasons = [];
    let imageHash = null;
    let amountMatch = false;
    let upiMatch = false;

    // ── 1. UTR VALIDATION (30%) ──
    const isUtrFormatValid = /^\d{12}$/.test(utr.trim());
    if (isUtrFormatValid) {
      confidenceScore += 15;
    } else {
      flagReasons.push('Invalid UTR Format');
    }

    const existingTxByUtr = await StockTransaction.findOne({ utr, _id: { $ne: id }, status: { $ne: 'CANCELLED' } });
    if (existingTxByUtr) {
      transaction.status = 'FAILED';
      transaction.utr = userUtr;
      transaction.ocrData = { flagReasons: ['Security Signal: TRANSACTION BLOCKED'] };
      await transaction.save();
      // Feature: Instant Recovery (Requirement: Stock again visible)
      await Stock.findByIdAndUpdate(transaction.stockId, { status: 'AVAILABLE' });
      return res.status(400).json({ success: false, message: 'TRANSACTION BLOCKED: This ID has already been utilized.' });
    }

    // ── 2. SCREENSHOT REUSE (ANTI-FRAUD) ──
    const utrValid = isUtrFormatValid && !existingTxByUtr;
    transaction.utr = userUtr;
    
    if (file && require('fs').existsSync(file.path)) {
      const fileBuffer = require('fs').readFileSync(file.path);
      imageHash = require('crypto').createHash('md5').update(fileBuffer).digest('hex');
    }

    transaction.imageHash = imageHash;
    if (file) transaction.screenshot = '/uploads/' + file.filename;

    if (req.io) req.io.emit('stock_update', { action: 'proof_uploaded', transactionId: id });

    // ── 5. AI OCR ANALYSIS (40%) ──
    if (file) {
        try {
          const result = await require('tesseract.js').recognize(file.path, 'eng');
          const text = result.data.text.toUpperCase();
          
          // Amount Extraction with Tolerance (±2)
          const expectedAmount = parseFloat(transaction.amount);
          const extractedAmountMatch = text.match(/(\d+\.\d{2})|(\d+)/g);
          if (extractedAmountMatch) {
            for (const val of extractedAmountMatch) {
              const v = parseFloat(val);
              if (Math.abs(v - expectedAmount) <= 2) {
                 amountMatch = true;
                 extractedData.extractedAmount = v;
                 break;
              }
            }
          }

          // 5.2 UPI Identity Extraction
          const sellerUpiId = (transaction.sellerId?.upiId || '').toUpperCase();
          if (sellerUpiId && text.includes(sellerUpiId)) {
             upiMatch = true;
             extractedData.extractedReceiver = sellerUpiId;
          }

          // 5.3 UTR Extraction from Screenshot
          const utrRegex = /(\d{12})|([A-Z0-9]{10,18})/g;
          const utrMatches = text.match(utrRegex);
          if (utrMatches) {
            for (const match of utrMatches) {
              const cleanedOCR = cleanUTR(match);
              const cleanedUser = cleanUTR(userUtr);
              if (cleanedOCR === cleanedUser || cleanedOCR.includes(cleanedUser) || cleanedUser.includes(cleanedOCR)) {
                 extractedData.extractedUtr = match;
                 extractedData.utrMatch = true;
                 break;
              }
            }
          }
        } catch (ocrErr) {
          console.error('[Neural OCR] AI Analysis Failure:', ocrErr);
          flagReasons.push('Neural OCR Engine Timeout');
        }
    }

    // ── 6. FINAL TIERED DECISION MATRIX ──
    const utrMatch = extractedData.utrMatch === true;
    transaction.ocrData = { ...extractedData, flagReasons, utrMatch };

    // FEATURE: INSTANT UTR SETTLEMENT (Requirement: Allow UTR-only)
    if (!file && utrValid) {
        transaction.status = 'SUCCESS';
        transaction.confidenceScore = 90; // High confidence based on unique UTR and session
        transaction.isProcessed = true;
        transaction.referenceId = `UTR-ONLY-${Date.now()}`;
        await transaction.save();
        await executeStockRotation(transaction, req);
        return res.json({ success: true, message: 'Instant Settlement: UTR verified successfully.', status: 'SUCCESS' });
    }

    if (utrMatch && amountMatch) {
       // TIER 1: HIGH CONFIDENCE CONSENSUS
       transaction.status = 'SUCCESS';
       transaction.confidenceScore = 100;
       transaction.isProcessed = true;
       transaction.referenceId = `UTR-MATCH-${Date.now()}`;
       await transaction.save();
       await executeStockRotation(transaction, req);
       return res.json({ success: true, message: 'Payment auto-verified: UTR and Amount match established.', status: 'SUCCESS' });
    } else if (utrMatch) {
       // TIER 2: UTR MATCH BUT AMOUNT FAULT
       transaction.status = 'PENDING_VERIFICATION';
       transaction.confidenceScore = 85;
       await transaction.save();
       return res.json({ success: true, message: 'UTR matched perfectly. Identity verification in progress for amount sync...', status: 'PENDING_VERIFICATION' });
    } else if (utrValid && amountMatch && upiMatch) {
       // TIER 3: HYBRID VALIDATION
       transaction.status = 'SUCCESS';
       transaction.confidenceScore = 95;
       transaction.isProcessed = true;
       transaction.referenceId = `HYBRID-MATCH-${Date.now()}`;
       await transaction.save();
       await executeStockRotation(transaction, req);
       return res.json({ success: true, message: 'Payment auto-verified via Hybrid consensus logic.', status: 'SUCCESS' });
    } else if (utrValid && amountMatch) {
       // TIER 4: PENDING REVIEW (FALLBACK)
       transaction.status = 'PENDING_VERIFICATION';
       transaction.confidenceScore = 75;
       await transaction.save();
       return res.json({ success: true, message: 'UTR and Amount matched, but identity signal is weak. Awaiting manual sync.', status: 'PENDING_VERIFICATION' });
    } else {
       // SYSTEM FAULT: MISMATCH DETECTED
       transaction.status = 'FAILED';
       transaction.confidenceScore = 30;
       await transaction.save();

       // Release stock node
       const stock = await Stock.findById(transaction.stockId);
       if (stock) {
         stock.status = 'AVAILABLE';
         stock.lockedUntil = null;
         await stock.save();
       }
       
       return res.status(400).json({ 
         success: false, 
         message: 'Verification Failed: Neural signals do not align.', 
         status: 'FAILED' 
       });
    }

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
    
    // RESTRICT CANCEL: If payment is already submitted for review, block user cancellation
    if (['PENDING_REVIEW', 'SUCCESS', 'FAILED'].includes(transaction.status)) {
       return res.status(400).json({ message: 'Cancellation restricted: Payment is currently being validated by Neural Node.' });
    }

    if (transaction) {
      transaction.status = 'FAILED';
      await transaction.save();
    }

    // Force release associated stock immediately
    const stockId = transaction ? transaction.stockId : null;
    if (stockId) {
      const stock = await Stock.findById(stockId);
      if (stock) {
        stock.status = 'AVAILABLE';
        stock.selectedBy = null;
        stock.selectionExpires = null;
        stock.lockedUntil = null;
        await stock.save();
        
        // Broadcast immediate visibility change
        if (req.io) {
          req.io.emit('stock_update', { action: 'locked', stockId: stock._id, status: 'AVAILABLE' });
        }
      }
    }

    if (req.io) req.io.emit('stock_update', { action: 'refresh' });
    res.json({ success: true, message: 'Transaction cancelled and node released' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// Redundant version removed to unify logic in adminController.js

exports.getTransaction = async (req, res) => {
  try {
    const transaction = await StockTransaction.findById(req.params.id)
      .populate('sellerId', 'name upiId qrCode userIdNumber');
    if (!transaction) return res.status(404).json({ success: false, message: 'Node not found' });
    res.json({ success: true, transaction });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

/* ─────────────────────────────────────────────────────────────
   POST /api/stocks/webhook — razorpay autonomous settlement
   (Requires RAZORPAY_WEBHOOK_SECRET in .env)
───────────────────────────────────────────────────────────── */
// Success!
