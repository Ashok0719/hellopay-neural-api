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
  res.json({
    stockPlans: config.stockPlans,
    minDeposit: config.minDeposit,
    maxDeposit: config.maxDeposit,
    globalCashbackPercent: config.globalCashbackPercent,
    depositEnabled: config.depositEnabled
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

module.exports = { createOrder, verifyPayment, getWalletHistory, getPublicConfig, simulatePayment };
