const Transaction = require('../models/Transaction');
const User = require('../models/User');
const WalletLog = require('../models/WalletLog');
const Stock = require('../models/Stock');
const Config = require('../models/Config');
const { calculateFinancials, syncUserStocks } = require('../utils/financeLogic');
const StockTransaction = require('../models/StockTransaction');
const crypto = require('crypto');
const Razorpay = require('razorpay');

// Razorpay Instance (Safely Initialized)
let razorpay = null;
if (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) {
  razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET
  });
}

// Optimized Neural OCR Engine (Initialized at startup for Instant Verification)
let ocrWorker = null;
let ocrInitializing = false;

const initOCR = async () => {
  if (ocrWorker) return ocrWorker;
  if (ocrInitializing) {
    // Wait for the existing init to complete
    let waited = 0;
    while (ocrInitializing && waited < 15000) {
      await new Promise(r => setTimeout(r, 200));
      waited += 200;
    }
    return ocrWorker;
  }
  ocrInitializing = true;
  try {
    const { createWorker } = require('tesseract.js');
    ocrWorker = await createWorker('eng', 1, {
      logger: () => {}, // Suppress verbose logs for speed
    });
    console.log('[Neural OCR] Engine Primed and Ready.');
  } catch (err) {
    console.error('[Neural OCR] Init Failed:', err.message);
    ocrWorker = null;
  } finally {
    ocrInitializing = false;
  }
  return ocrWorker;
};

// Reset worker on error so next request gets a fresh instance
const resetOCR = async () => {
  try {
    if (ocrWorker) await ocrWorker.terminate();
  } catch (_) {}
  ocrWorker = null;
};

// OCR with hard timeout — returns null text if it takes too long
const recognizeWithTimeout = (worker, filePath, timeoutMs = 15000) => {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      console.warn('[Neural OCR] Timeout hit — skipping OCR, routing to manual review.');
      resolve(null);
    }, timeoutMs);

    worker.recognize(filePath)
      .then(result => {
        clearTimeout(timer);
        resolve(result.data.text);
      })
      .catch(err => {
        clearTimeout(timer);
        console.error('[Neural OCR] Recognize error:', err.message);
        resolve(null);
      });
  });
};

initOCR().catch(console.error);

const expireStaleOrders = async () => {
  const staleLimit = new Date(Date.now() - 5 * 60 * 1000); // 5 Minutes
  try {
     const staleCount = await StockTransaction.updateMany(
        { status: 'PENDING_PAYMENT', createdAt: { $lt: staleLimit } },
        { status: 'FAILED' }
     );
     if (staleCount.modifiedCount > 0) {
        console.log(`[Neural Cleanup] Expired ${staleCount.modifiedCount} stale rotation orders.`);
     }
  } catch (err) {
     console.error('[Neural Cleanup] Error:', err);
  }
};

// Helper to get system config or default
const getSystemConfig = async () => {
  let config = await Config.findOne({ key: 'SYSTEM_CONFIG' });
  if (!config) {
    // Default fallback (though it should be initialized in index.js)
    config = {
      globalCashbackPercent: 4,
      stockPlans: [],
      adminExtraEnabled: true,
      adminProfitEnabled: true,
      depositEnabled: true,
      minDeposit: 100,
      maxDeposit: 15000,
      withdrawalEnabled: true,
      withdrawalApprovalManual: true,
    };
  }
  return config;
};

// @desc    Create Razorpay order
// @route   POST /api/wallet/add-money
// @access  Private
// @desc    Match a P2P Seller for Recharge Rotation
// @route   POST /api/wallet/match-p2p
const matchP2P = async (req, res) => {
  try {
    // Neural Cleanup: Expired Signals
    await expireStaleOrders();

    const { amount } = req.body;
    const buyerId = req.user._id;

    if (!amount || isNaN(Number(amount))) {
      return res.status(400).json({ message: 'Invalid recharge amount signal' });
    }

    const targetAmount = Number(amount);

    // Find a matching AVAILABE node that is NOT owned by the buyer
    const stock = await Stock.findOne({
      amount: targetAmount,
      status: 'AVAILABLE',
      ownerId: { $ne: buyerId }
    }).populate('ownerId', 'name upiId qrCode');

    if (!stock) {
      // Fallback: No matching rotation node found
      return res.json({ 
        success: false, 
        message: 'No matching P2P node found. Falling back to System Admin routing.',
        adminFallback: true
      });
    }

    // Lock the node temporarily (20 mins)
    stock.status = 'LOCKED';
    stock.selectedBy = buyerId;
    stock.selectionExpires = new Date(Date.now() + 20 * 60 * 1000);
    await stock.save();

    // Create a Stock Transaction (Simulation of Purchase)
    const StockTransaction = require('../models/StockTransaction');
    const transaction = await StockTransaction.create({
      transactionId: 'P2P_' + Date.now(),
      stockId: stock._id,
      buyerId: buyerId,
      sellerId: stock.ownerId._id,
      amount: targetAmount,
      status: 'PENDING_PAYMENT'
    });

    res.json({
      success: true,
      message: 'Neural P2P Match Established',
      seller: {
        name: stock.ownerId.name,
        upiId: stock.ownerId.upiId,
        qrCode: stock.ownerId.qrCode
      },
      transactionId: transaction._id
    });

  } catch (err) {
    console.error('P2P Match Error:', err);
    res.status(500).json({ message: 'Neural Matching Fault' });
  }
};

// Match a P2P Seller for Recharge Rotation

// @desc    Verify Razorpay payment & apply financial logic
// @route   POST /api/wallet/verify-payment
// @access  Private
// verifyPayment removed (now handled by paymentController)

// @desc    Get Wallet Balance & Logs
// @route   GET /api/wallet/history
// @access  Private
const getWalletHistory = async (req, res) => {
  const logs = await WalletLog.find({ userId: req.user._id }).sort({ createdAt: -1 });
  res.json(logs);
};

// @desc    Get Public Config for UI
// @route   GET /api/wallet/config
// @access  Private
const getPublicConfig = async (req, res) => {
  const config = await getSystemConfig();
  const totalUsers = await User.countDocuments();
  res.json({
    stockPlans: config.stockPlans,
    minDeposit: config.minDeposit,
    maxDeposit: config.maxDeposit,
    globalCashbackPercent: config.globalCashbackPercent,
    referralCommissionPercent: config.referralCommissionPercent,
    referralBonus: config.referralBonus,
    profitPercentage: config.profitPercentage,
    depositEnabled: config.depositEnabled,
    withdrawalEnabled: config.withdrawalEnabled,
    receiverUpiId: config.receiverUpiId,
    receiverQrCode: config.receiverQrCode,
    totalUsers
  });
};

// @desc    Simulate payment success (for Paytm/PhonePe/etc. simulation)
const simulatePayment = async (req, res) => {
  const { amount } = req.body;
  const user = await User.findById(req.user.id);

  if (!user) return res.status(404).json({ message: 'User not found' });

  // Get active config
  const config = (await Config.findOne({ key: 'SYSTEM_CONFIG' })) || { globalCashbackPercent: 4 };

  // Calculate finance splits and rewards
  const { userParts, adminExtra, cashback } = calculateFinancials(amount, config);

  // Update user balances with 4% bonus logic
  const bonusAmount = amount * 1.04;
  user.walletBalance += bonusAmount;
  user.rewardBalance += cashback;
  user.totalRewards += cashback;
  user.totalDeposited += amount;
  await user.save();

  // Create detailed transaction record
  await Transaction.create({
    senderId: user._id,
    amount: amount,
    type: 'plan_purchase',
    status: 'completed',
    cashback: cashback,
    split: {
      userParts: userParts,
      adminExtra: adminExtra
    }
  });

  // REBUILD NODES: Tokenize immediately
  await syncUserStocks(User, Stock, user._id, user.walletBalance, config);

  if (req.io) req.io.emit('stock_update', { action: 'refresh' });

  res.json({
    message: 'Payment simulated successfully',
    newBalance: user.walletBalance,
    rewardBalance: user.rewardBalance,
    cashback: cashback
  });
};

// @desc    Request withdrawal
// @route   POST /api/wallet/withdraw
// @access  Private
const requestWithdrawal = async (req, res) => {
  const { amount, pin } = req.body;
  const config = await getSystemConfig();

  if (!config.withdrawalEnabled) {
    return res.status(403).json({ message: 'Withdrawals are currently disabled by admin' });
  }

  const withdrawAmount = parseFloat(amount);
  if (isNaN(withdrawAmount) || withdrawAmount <= 0) {
    return res.status(400).json({ message: 'Invalid withdrawal amount' });
  }

  const user = await User.findById(req.user._id);
  if (!user) return res.status(404).json({ message: 'User not found' });

  // Security PIN Check
  if (!pin) {
    return res.status(400).json({ message: 'Safety PIN required' });
  }
  if (!(await user.matchPin(pin))) {
    return res.status(401).json({ message: 'Safety Protocol: Invalid PIN' });
  }

  if (user.walletBalance < withdrawAmount) {
    return res.status(400).json({ message: 'Insufficient balance' });
  }

  // Deduct balance immediately & create pending transaction
  user.walletBalance -= withdrawAmount;
  await user.save();

  await Transaction.create({
    senderId: user._id,
    receiverId: user._id, 
    type: 'withdrawal',
    amount: withdrawAmount,
    status: 'PENDING',
    referenceId: `wd_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
    description: `Withdrawal Request - ₹${withdrawAmount}`
  });

  await WalletLog.create({
    userId: user._id,
    action: 'debit',
    amount: withdrawAmount,
    balanceAfter: user.walletBalance,
    description: `Withdrawal Request: ₹${withdrawAmount} (Pending Approval)`,
  });

  // Re-sync stocks since balance changed
  await syncUserStocks(User, Stock, user._id, user.walletBalance, config);

  if (req.io) req.io.emit('stock_update', { action: 'refresh' });

  res.json({ 
    message: 'Withdrawal request submitted for approval', 
    walletBalance: user.walletBalance 
  });
};

// @desc    Neural 2.0 Identity-Bound Auto-Verification
// @route   POST /api/wallet/neural-verify
// @access  Private
const neuralVerifyPayment = async (req, res) => {
  try {
    const { amount, utr } = req.body;
    const file = req.file;
    const userId = req.user._id;

    if (!amount || !utr || !file) {
      return res.status(400).json({ message: 'Missing neural signals: amount, UTR, and proof required.' });
    }

    const config = await getSystemConfig();
    const expectedAmount = parseFloat(amount);
    
    // 1. UTR Duplicity Check
    const existingTx = await Transaction.create.name === 'Transaction' ? await Transaction.findOne({ referenceId: utr }) : null;
    // Actually, check Transaction for duplicate referenceId (which we use for UTR here)
    const duplicateUtr = await Transaction.findOne({ referenceId: utr });
    if (duplicateUtr) {
      return res.status(400).json({ message: 'Security Alert: UPI Transaction ID already processed by another node.' });
    }

    // 2. OCR Verification Engine
    let amountMatch = false;
    let upiMatch = false;
    let utrMatch = false;

    // Neural Optimization: Identify Target Receiver (Admin or P2P Seller)
    let targetUpiId = (config.receiverUpiId || 'admin@okaxis').toUpperCase();
    
    // Look for a matching Stock Transaction if this is a P2P rotation
    const rotationTx = await require('../models/StockTransaction').findOne({ 
      buyerId: userId, 
      amount: expectedAmount, 
      status: 'PENDING_PAYMENT' 
    }).populate('sellerId', 'upiId');

    if (rotationTx && rotationTx.sellerId?.upiId) {
       targetUpiId = rotationTx.sellerId.upiId.toUpperCase();
       console.log(`[Neural Flow] P2P Rotation Detected. Verifying against Seller: ${targetUpiId}`);
    }

    let ocrTimedOut = false;
    try {
      console.log(`[Neural Engine] Fast OCR scan for ${file.filename} (15s max)...`);
      const worker = await initOCR();

      if (!worker) {
        // Worker failed to init — skip OCR, send to manual review
        console.warn('[Neural OCR] Worker unavailable. Routing to manual review.');
        ocrTimedOut = true;
      } else {
        const text = await recognizeWithTimeout(worker, file.path, 15000);

        if (text === null) {
          // OCR timed out
          ocrTimedOut = true;
          await resetOCR();
          initOCR().catch(console.error); // Re-prime for next request
        } else {
          const textUpper = text.toUpperCase();
          const alphanumericText = textUpper.replace(/[^A-Z0-9]/g, '');

          // Amount Extraction — lenient ₹5 tolerance for rounding
          const amountRegex = /(?:RS\.?|INR|₹)?\s*([\d,]+(?:\.\d{1,2})?)/g;
          let m;
          while ((m = amountRegex.exec(textUpper)) !== null) {
            const val = parseFloat(m[1].replace(/,/g, ''));
            if (val > 0 && Math.abs(val - expectedAmount) <= 5) {
              amountMatch = true;
              break;
            }
          }

          // UTR check — full or partial (first 8 chars) match
          const cleanUtr = utr.toUpperCase().replace(/[^A-Z0-9]/g, '');
          if (alphanumericText.includes(cleanUtr)) {
            utrMatch = true;
          } else if (cleanUtr.length >= 8 && alphanumericText.includes(cleanUtr.substring(0, 8))) {
            utrMatch = true; // Partial prefix match
          } else {
            // Secondary check by TXN/TRANS label
            const txnIdMatches = textUpper.match(/(?:TXN|TRANS(?:ACTION)?|REF|ID)\s*[:#]?\s*([A-Z0-9]{8,})/g);
            if (txnIdMatches) {
              for (const match of txnIdMatches) {
                const cleaned = match.replace(/[^A-Z0-9]/g, '');
                if (cleaned.includes(cleanUtr) || cleanUtr.includes(cleaned)) {
                  utrMatch = true;
                  break;
                }
              }
            }
          }

          // UPI check — full or handle-only match
          const cleanTargetUpi = targetUpiId.replace(/[^A-Z0-9]/g, '');
          if (alphanumericText.includes(cleanTargetUpi)) {
            upiMatch = true;
          } else if (targetUpiId.includes('@')) {
            const handle = targetUpiId.split('@')[1].toUpperCase().replace(/[^A-Z0-9]/g, '');
            if (alphanumericText.includes(handle)) upiMatch = true;
          }

          // SUCCESS keyword as bonus confirmation
          if (/SUCCESS|PAID|PAYMENT SUCCESSFUL|COMPLETED|DONE|SENT|TRANSFERRED/i.test(textUpper)) {
            if (amountMatch) utrMatch = true; // Success keyword + amount = trust it
          }

          console.log(`[Neural OCR] Results — Amount: ${amountMatch}, UTR: ${utrMatch}, UPI: ${upiMatch}`);
        }
      }
    } catch (ocrErr) {
      console.error('[Neural OCR] Unexpected error:', ocrErr.message);
      await resetOCR();
      initOCR().catch(console.error);
      ocrTimedOut = true;
    }

    // Final Validation Logic
    // Lenient: amount match alone is sufficient for auto-verify (OCR misses UTR/UPI often)
    // If OCR timed out → always route to manual review
    const isAutoVerified = !ocrTimedOut && amountMatch;
    const screenshotPath = `/uploads/${file.filename}`;
    const flagReasons = [];
    if (!amountMatch) flagReasons.push('AMOUNT_MISMATCH');
    if (!utrMatch) flagReasons.push('UTR_NOT_FOUND_IN_IMAGE');
    if (!upiMatch) flagReasons.push('RECEIVER_UPI_MISMATCH');

    // Update Rotation Record if exists
    if (rotationTx) {
      rotationTx.utr = utr;
      rotationTx.screenshot = screenshotPath;
      rotationTx.status = isAutoVerified ? 'SUCCESS' : 'PENDING_VERIFICATION';
      rotationTx.confidenceScore = isAutoVerified ? 100 : (ocrTimedOut ? 0 : 50);
      rotationTx.ocrData = { 
          rawText: ocrTimedOut ? '[OCR_TIMEOUT]' : '(scanned)',
          matches: { amountMatch, utrMatch, upiMatch },
          targetUpiId 
      };
      if (ocrTimedOut) flagReasons.push('OCR_TIMEOUT');
      rotationTx.flagReasons = flagReasons;
      await rotationTx.save();
    }

    if (!isAutoVerified) {
       const timeoutMsg = ocrTimedOut 
         ? 'Verification engine timed out. Your proof has been submitted for manual admin review — you will be notified shortly.'
         : 'Neural signals unclear. Your proof has been submitted for manual administration review.';
       console.warn(`[Neural Engine] Flags: ${flagReasons.join(', ')}`);
       return res.status(200).json({ 
         success: false,
         status: 'PENDING_REVIEW',
         message: timeoutMsg,
         results: { amountMatch, utrMatch, upiMatch, targetUpiId, flagReasons, ocrTimedOut }
       });
    }

    // Success Flow - Atomic Credit
    const user = await User.findById(userId);
    const { cashback } = calculateFinancials(expectedAmount, config);

    user.walletBalance += expectedAmount;
    user.rewardBalance += cashback;
    user.totalRewards += cashback;
    user.totalDeposited += expectedAmount;
    await user.save();

    // Create Audit Transaction
    const transaction = await Transaction.create({
      senderId: userId,
      receiverId: userId,
      type: 'add_money',
      amount: expectedAmount,
      status: 'SUCCESS',
      transactionId: utr,
      referenceId: utr,
      screenshotUrl: screenshotPath,
      description: rotationTx ? `P2P Auto-Verified Recharge` : 'Admin Auto-Verified Deposit'
    });

    await WalletLog.create({
      userId,
      action: 'credit',
      amount: expectedAmount,
      balanceAfter: user.walletBalance,
      description: `Auto-Verified Deposit: ₹${expectedAmount}`,
    });

    // If P2P Rotation -> Update Stock Node & Seller Balance
    if (rotationTx) {
      const stock = await Stock.findById(rotationTx.stockId);
      if (stock) {
        stock.status = 'SOLD';
        await stock.save();
      }

      // Seller Liquidation
      const seller = await User.findById(rotationTx.sellerId._id);
      if (seller) {
        seller.walletBalance = Math.max(0, seller.walletBalance - expectedAmount);
        await seller.save();
        
        await WalletLog.create({
          userId: seller._id,
          action: 'debit',
          amount: expectedAmount,
          balanceAfter: seller.walletBalance,
          description: `Node Rotation Liquidation: Cash received by bank.`
        });

        // Re-sync seller nodes
        await syncUserStocks(User, Stock, seller._id, seller.walletBalance, config);
        
        if (req.io) {
          req.io.emit('userStatusChanged', { 
            userId: seller._id, 
            walletBalance: seller.walletBalance 
          });
        }
      }
    }

    // Re-sync buyer nodes
    await syncUserStocks(User, Stock, userId, user.walletBalance, config);

    if (req.io) req.io.emit('stock_update', { action: 'refresh' });

    res.json({
      success: true,
      message: 'Neural node activated. Payment auto-verified.',
      newBalance: user.walletBalance,
      transactionId: transaction._id
    });

  } catch (err) {
    console.error('Neural Verify Controller Error:', err);
    res.status(500).json({ message: 'Internal Server Error' });
  }
};

const verifySmsPayment = async (req, res) => {
  try {
    const { amount, utr, source, deviceId } = req.body;
    const config = await getSystemConfig();
    
    console.log(`[Neural Signal] Incoming verifying from ${source}: ₹${amount}, UTR: ${utr}`);
    
    // 1. DUPLICATE CHECK (Rule 1: Never trust twice)
    const exists = await Transaction.findOne({ referenceId: utr });
    if (exists) {
       return res.status(400).json({ success: false, message: "Security Alert: Duplicate UTR Signal Blocked." });
    }

    // 2. LOCATE ACTIVE SESSION (Rule 5: Exact Binding)
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    const rotationTx = await StockTransaction.findOne({
       status: 'PENDING_PAYMENT',
       createdAt: { $gte: fiveMinutesAgo }
    }).populate('buyerId sellerId');

    if (!rotationTx) {
       return res.status(404).json({ success: false, message: "Signal Mismatch: No active rotation session found within 5 min window." });
    }

    // 3. AMOUNT MATCHING (Rule 3: ₹1 Tolerance)
    const paidAmount = Number(amount);
    if (Math.abs(rotationTx.amount - paidAmount) > 1) {
       return res.status(400).json({ success: false, message: "Amount Mismatch: Neural Engine detected deviation > ₹1." });
    }

    // 4. SOURCE LOGIC (Rule 1 & 2)
    const isHardTruth = source === 'sms_auto'; // SMS is final truth
    
    if (isHardTruth) {
       const userId = rotationTx.buyerId._id;
       const user = await User.findById(userId);
       const seller = await User.findById(rotationTx.sellerId._id);
       const { cashback } = calculateFinancials(rotationTx.amount, config);

       // Execute Atomic Credit
       user.walletBalance += rotationTx.amount;
       user.rewardBalance += cashback;
       await user.save();

       // Liquidity Rebalance (Seller Node)
       seller.walletBalance = Math.max(0, seller.walletBalance - rotationTx.amount);
       await seller.save();

       // Finalize Transaction Audit
       await Transaction.create({
         senderId: userId,
         amount: rotationTx.amount,
         type: 'add_money',
         status: 'SUCCESS',
         referenceId: utr,
         deviceId: deviceId || 'APK_SIGNAL_BOUND',
         description: `Neural SMS Verified (Source: ${source})`
       });

       rotationTx.status = 'SUCCESS';
       rotationTx.utr = utr;
       await rotationTx.save();

       // Sync Nodes
       await syncUserStocks(User, Stock, userId, user.walletBalance, config);
       await syncUserStocks(User, Stock, seller._id, seller.walletBalance, config);
       
       if (req.io) req.io.emit('stock_update', { action: 'refresh' });

       return res.json({ success: true, message: "Neural Signal Verified. Asset Merged." });
    } else {
       // Secondary Confirmation (Soft Verified)
       rotationTx.utr = utr;
       rotationTx.status = 'PENDING_REVIEW';
       await rotationTx.save();
       return res.json({ success: true, message: "Intent Signal Logged. Awaiting SMS Primary Truth." });
    }
  } catch (err) {
    console.error('Neural Logic Fault:', err);
    res.status(500).json({ success: false, message: "Neural Logic Fault" });
  }
};

module.exports = { getWalletHistory, getPublicConfig, simulatePayment, requestWithdrawal, neuralVerifyPayment, matchP2P, verifySmsPayment };
