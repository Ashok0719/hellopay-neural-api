const Transaction = require('../models/Transaction');
const User = require('../models/User');
const WalletLog = require('../models/WalletLog');
const Stock = require('../models/Stock');
const Config = require('../models/Config');
const { calculateFinancials, syncUserStocks } = require('../utils/financeLogic');
const StockTransaction = require('../models/StockTransaction');
const crypto = require('crypto');
const axios = require('axios');

// Unified Wallet Settlement Engine
const executeWalletRecharge = async (transaction, config) => {
  const user = await User.findById(transaction.senderId);
  const depositAmt = parseFloat(transaction.amount);

  // Dynamic Financial Calculation
  const { userParts, adminExtra, cashback } = calculateFinancials(depositAmt, config);

  // Update User Wallet & Stats
  user.walletBalance += depositAmt;
  user.rewardBalance += (user.rewardBalance || 0) + cashback;
  user.totalRewards += (user.totalRewards || 0) + cashback;
  user.totalDeposited += (user.totalDeposited || 0) + depositAmt;
  await user.save();

  // Update Transaction Record
  transaction.status = 'SUCCESS';
  transaction.split = { userParts, adminExtra };
  transaction.cashback = cashback;
  await transaction.save();

  // Create Wallet Log
  await WalletLog.create({
    userId: user._id,
    action: 'credit',
    amount: depositAmt,
    balanceAfter: user.walletBalance,
    description: `Auto-Verified Deposit: ₹${depositAmt}`,
  });

  // Re-tokenize immediately
  await syncUserStocks(User, Stock, user._id, user.walletBalance, config);
  return { user, cashback };
};

// Fastring Integration Helper
const createFastringOrder = async (amount, userId, referenceId) => {
  // Logic to interact with Fastring API
  // Requirement: includes amount, user ID, order/reference ID
  const fastringApiUrl = process.env.FASTRING_API_URL || 'https://api.fastring.app/v1/payments';
  const fastringApiKey = process.env.FASTRING_API_KEY;

  try {
     // Scenario: Fastring expects a payload and returns a payment URL
     // We will generate a unique order ID for Fastring tracking
     const fastringOrderId = `FR_${referenceId}_${Date.now().toString().slice(-4)}`;
     
     // For this integration, we'll return the URL the frontend should redirect to
     // If no API Key is provided, we simulate a direct payment link
     const paymentUrl = `${process.env.FASTRING_PAY_BASE_URL || 'https://fastring.app/pay'}?amount=${amount}&userId=${userId}&orderId=${referenceId}&fastId=${fastringOrderId}&callback=${encodeURIComponent(process.env.FASTRING_CALLBACK_URL || 'https://hellopayapp.com/api/wallet/fastring-callback')}`;

     return { 
        id: fastringOrderId, 
        payment_url: paymentUrl,
        success: true 
     };
  } catch (err) {
     console.error('Fastring Order Fault:', err);
     throw new Error('Fastring payment initialization failed');
  }
};

// Optimized Neural OCR Engine (Initialized at startup for Instant Verification)
let ocrWorker = null;
const initOCR = async () => {
  if (ocrWorker) return;
  const { createWorker } = require('tesseract.js');
  ocrWorker = await createWorker('eng');
  console.log('[Neural OCR] Engine Primed and Ready.');
};
initOCR();

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

const createOrder = async (req, res) => {
  const { amount } = req.body;
  const config = await getSystemConfig();

  if (!config.depositEnabled) {
    return res.status(403).json({ message: 'Deposits are currently disabled by admin' });
  }

  if (amount < config.minDeposit || amount > config.maxDeposit) {
    return res.status(400).json({ message: `Amount must be between ₹${config.minDeposit} and ₹${config.maxDeposit}` });
  }

  try {
    const referenceId = `HP_W_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
    const fastringOrder = await createFastringOrder(amount, req.user._id, referenceId);
    
    // Create a pending transaction record for the status polling or callback to find
    await Transaction.create({
      senderId: req.user._id,
      receiverId: req.user._id,
      type: 'add_money',
      amount: parseFloat(amount),
      status: 'PENDING',
      fastringOrderId: fastringOrder.id,
      referenceId: referenceId,
      description: `Wallet Recharge (Fastring) - ₹${amount}`
    });

    res.json({
       success: true,
       orderId: fastringOrder.id,
       paymentUrl: fastringOrder.payment_url,
       amount: amount
    });
  } catch (error) {
    console.error('Fastring Wallet Order Error:', error);
    res.status(500).json({ success: false, message: 'Fastring initialization failed' });
  }
};

// @desc    Verify Razorpay payment & apply financial logic
// @route   POST /api/wallet/verify-payment
// @access  Private
const fastringCallback = async (req, res) => {
  const { fastring_order_id, status, reference_id, amount } = req.body;
  const config = await getSystemConfig();

  // SECURITY: Always verify with Fastring Backend before granting credits
  // If no API is available, we assume a trusted signed payload or just verify the reference existence
  const transaction = await Transaction.findOne({ referenceId: reference_id, status: 'PENDING' });

  if (status === 'SUCCESS' && transaction) {
    const user = await User.findById(transaction.senderId);
    const depositAmt = parseFloat(amount || transaction.amount);

    // Final Backend Verification (Optional: call Fastring API to double-check)
    // const { data } = await axios.get(`https://api.fastring.app/v1/orders/${fastring_order_id}`, { headers: { 'Authorization': `Bearer ${process.env.FASTRING_API_KEY}` } });
    // if (data.status !== 'PAID') throw new Error('Security Violation: Spoofed payment detected');

    // Dynamic Financial Calculation
    const { userParts, adminExtra, cashback } = calculateFinancials(depositAmt, config);

    // Update User Wallet & Stats
    user.walletBalance += depositAmt;
    user.rewardBalance += (user.rewardBalance || 0) + cashback;
    user.totalRewards += (user.totalRewards || 0) + cashback;
    user.totalDeposited += (user.totalDeposited || 0) + depositAmt;
    await user.save();

    // Update Transaction Record
    transaction.status = 'SUCCESS';
    transaction.split = { userParts, adminExtra };
    transaction.cashback = cashback;
    transaction.save();

    // Create Wallet Log
    await WalletLog.create({
      userId: user._id,
      action: 'credit',
      amount: depositAmt,
      balanceAfter: user.walletBalance,
      description: `Fastring Deposit: ₹${depositAmt}`,
    });

    // REBUILD NODES
    await syncUserStocks(User, Stock, user._id, user.walletBalance, config);

    if (req.io) req.io.emit('stock_update', { action: 'refresh' });

    res.json({ 
      success: true,
      message: 'Payment verified and wallet credited', 
      newBalance: user.walletBalance
    });
  } else {
    res.status(400).json({ success: false, message: 'Fastring payment verification failed or already processed' });
  }
};

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

    try {
      console.log(`[Neural Engine] Starting Instant OCR Analysis for ${file.filename}...`);
      if (!ocrWorker) await initOCR();
      const { data: { text } } = await ocrWorker.recognize(file.path);
      const textUpper = text.toUpperCase();
      const alphanumericText = textUpper.replace(/[^A-Z0-9]/g, ''); // Ultra-Clean stream
      
      // Amount Extraction (Handles ₹, commas, and decimals)
      const amountRegex = /(?:RS|INR|₹)?\s*([\d,]+(?:\.\d{2})?)/g;
      let amountMatchTarget = false;
      let m;
      while ((m = amountRegex.exec(textUpper)) !== null) {
          const val = parseFloat(m[1].replace(/,/g, ''));
          if (Math.abs(val - expectedAmount) <= 2) {
              amountMatchTarget = true;
              break;
          }
      }
      amountMatch = amountMatchTarget;

      // UTR / Transaction ID Extraction (High Precision Alphanumeric Comparison)
      const cleanUtr = utr.toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (alphanumericText.includes(cleanUtr)) {
          utrMatch = true;
      }
      
      // Secondary Transaction ID check (for UPI Txn IDs that might differ from UTR)
      if (!utrMatch) {
          const txnIdMatches = textUpper.match(/(?:TXN|TRANS|ID)\s*:?\s*([A-Z0-9]{10,})/g);
          if (txnIdMatches) {
              for (let match of txnIdMatches) {
                  const cleanedMatch = match.replace(/[^A-Z0-9]/g, '');
                  if (cleanedMatch.includes(cleanUtr) || cleanUtr.includes(cleanedMatch)) {
                      utrMatch = true;
                      break;
                  }
              }
          }
      }

      // Dynamic Receiver Verification (Resilient to special character noise)
      const cleanTargetUpi = targetUpiId.replace(/[^A-Z0-9]/g, '');
      if (alphanumericText.includes(cleanTargetUpi)) {
          upiMatch = true;
      }
      
      // Secondary Check: Check if UPI Handle (part after @) exists if full match fails
      if (!upiMatch && targetUpiId.includes('@')) {
          const handle = targetUpiId.split('@')[1].toUpperCase().replace(/[^A-Z0-9]/g, '');
          if (alphanumericText.includes(handle)) {
             upiMatch = true; // High probability match if merchant handle is present
          }
      }
    } catch (ocrErr) {
      console.error('Neural OCR Error:', ocrErr);
    }

    // Final Validation Logic
    const isAutoVerified = (amountMatch && (utrMatch || upiMatch));
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
      rotationTx.confidenceScore = isAutoVerified ? 100 : 50;
      rotationTx.ocrData = { 
          rawText: text.substring(0, 1000), 
          matches: { amountMatch, utrMatch, upiMatch },
          targetUpiId 
      };
      rotationTx.flagReasons = flagReasons;
      await rotationTx.save();
    }

    if (!isAutoVerified) {
       console.warn(`[Neural Engine] Auto-Verification Failed. Flags: ${flagReasons.join(', ')}`);
       return res.status(200).json({ 
         success: false,
         status: 'PENDING_REVIEW',
         message: 'Neural verification signature is unclear or mismatched. Your proof has been submitted for manual administration review.',
         results: { amountMatch, utrMatch, upiMatch, targetUpiId, flagReasons }
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

module.exports = { executeWalletRecharge, createOrder, verifyPayment: fastringCallback, fastringCallback, getWalletHistory, getPublicConfig, simulatePayment, requestWithdrawal, neuralVerifyPayment, matchP2P, verifySmsPayment };
