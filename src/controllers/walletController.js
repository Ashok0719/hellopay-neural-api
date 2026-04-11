const Transaction = require('../models/Transaction');
const User = require('../models/User');
const WalletLog = require('../models/WalletLog');
const Stock = require('../models/Stock');
const Config = require('../models/Config');
const { calculateFinancials, syncUserStocks } = require('../utils/financeLogic');

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

  const options = {
    amount: Math.round(amount * 100), // amount in paisa
    currency: 'INR',
    receipt: `receipt_${Date.now()}`,
  };

  try {
    const order = await instance.orders.create(options);
    res.json(order);
  } catch (error) {
    res.status(500);
    throw new Error('Order creation failed');
  }
};

// @desc    Verify Razorpay payment & apply financial logic
// @route   POST /api/wallet/verify-payment
// @access  Private
const verifyPayment = async (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature, amount } = req.body;
  const config = await getSystemConfig();

  const body = razorpay_order_id + "|" + razorpay_payment_id;

  const expectedSignature = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET || 'test_key_secret')
    .update(body.toString())
    .digest('hex');

  const isAuthentic = expectedSignature === razorpay_signature;

  if (isAuthentic) {
    const user = await User.findById(req.user._id);
    const depositAmt = parseFloat(amount);

    // Dynamic Financial Calculation
    const { userParts, adminExtra, cashback } = calculateFinancials(depositAmt, config);

    // Update User Wallet & Stats
    user.walletBalance += depositAmt;
    user.rewardBalance += cashback;
    user.totalRewards += cashback;
    user.totalDeposited += depositAmt;
    await user.save();

    // Create Transaction Record with Split Metadata
    await Transaction.create({
      senderId: req.user._id,
      receiverId: req.user._id,
      type: 'plan_purchase',
      amount: depositAmt,
      split: {
        userParts,
        adminExtra
      },
      cashback,
      status: 'success',
      referenceId: razorpay_payment_id,
      description: `Stock Plan Purchase - ${depositAmt}`
    });

    // Create Wallet Log (For user balance tracking)
    await WalletLog.create({
      userId: req.user._id,
      action: 'credit',
      amount: depositAmt,
      balanceAfter: user.walletBalance,
      description: `Deposit for stock split: ₹${userParts.join(' + ₹')}`,
    });

    // REBUILD NODES (Continuous Rotation): Re-tokenize immediately after payment credit
    await syncUserStocks(User, Stock, req.user._id, user.walletBalance, config);

    if (req.io) req.io.emit('stock_update', { action: 'refresh' });

    res.json({ 
      message: 'Plan purchase successful', 
      user: {
        walletBalance: user.walletBalance,
        rewardBalance: user.rewardBalance,
        totalDeposited: user.totalDeposited
      },
      split: userParts,
      cashback
    });
  } else {
    res.status(400);
    throw new Error('Payment verification failed');
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
    const existingTx = await Transaction.create.name === 'Transaction' ? await Transaction.findOne({ referenceId: utr }) : null;
    // Actually, check Transaction for duplicate referenceId (which we use for UTR here)
    const duplicateUtr = await Transaction.findOne({ referenceId: utr });
    if (duplicateUtr) {
      return res.status(400).json({ message: 'Security Alert: UTR already processed by another node.' });
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
    } else {
       console.log(`[Neural Flow] Standard Add-Money. Verifying against Admin: ${targetUpiId}`);
    }

    try {
      const result = await require('tesseract.js').recognize(file.path, 'eng');
      const text = result.data.text.toUpperCase();
      
      // Amount Extraction
      const matches = text.match(/(\d+\.\d{2})|(\d+)/g);
      if (matches) {
          for (const val of matches) {
              if (Math.abs(parseFloat(val) - expectedAmount) <= 2) {
                  amountMatch = true;
                  break;
              }
          }
      }

      // UTR Extraction
      if (text.includes(utr.toUpperCase())) {
          utrMatch = true;
      }

      // Dynamic Receiver Verification (Seller or Admin)
      if (text.includes(targetUpiId)) {
          upiMatch = true;
      }
    } catch (ocrErr) {
      console.error('Neural OCR Error:', ocrErr);
    }

    // Final Validation Logic
    const isAutoVerified = (amountMatch && (utrMatch || upiMatch));

    if (!isAutoVerified) {
       return res.status(400).json({ 
         message: 'Neural verification failed. Accuracy threshold not met. Identity verification failed.',
         results: { amountMatch, utrMatch, upiMatch, targetUpiId }
       });
    }

    // Success Flow - Atomic Credit
    const user = await User.findById(userId);
    const { userParts, adminExtra, cashback } = calculateFinancials(expectedAmount, config);

    user.walletBalance += expectedAmount;
    user.rewardBalance += cashback;
    user.totalRewards += cashback;
    user.totalDeposited += expectedAmount;
    await user.save();

    const transaction = await Transaction.create({
      senderId: userId,
      receiverId: userId,
      type: 'add_money',
      amount: expectedAmount,
      status: 'SUCCESS',
      transactionId: utr,
      referenceId: utr,
      screenshotUrl: `/uploads/${file.filename}`,
      description: 'Auto-Verified Neural Deposit'
    });

    await WalletLog.create({
      userId,
      action: 'credit',
      amount: expectedAmount,
      balanceAfter: user.walletBalance,
      description: `Auto-Verified Deposit: ₹${expectedAmount}`,
    });

    // Sync stocks
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

module.exports = { createOrder, verifyPayment, getWalletHistory, getPublicConfig, simulatePayment, requestWithdrawal, neuralVerifyPayment, matchP2P };
