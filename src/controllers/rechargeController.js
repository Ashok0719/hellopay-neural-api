const User = require('../models/User');
const Recharge = require('../models/Recharge');
const Transaction = require('../models/Transaction');
const WalletLog = require('../models/WalletLog');

// @desc    Mock mobile recharge
// @route   POST /api/recharge/mobile
// @access  Private
const rechargeMobile = async (req, res) => {
  const { mobileNumber, operator, amount } = req.body;
  const rechargeAmount = Number(amount);

  const user = await User.findById(req.user._id);

  if (user.walletBalance < rechargeAmount) {
    res.status(400);
    throw new Error('Insufficient balance');
  }

  // Update user balance
  user.walletBalance -= rechargeAmount;
  await user.save();

  // Create Recharge Record
  const recharge = await Recharge.create({
    userId: user._id,
    mobileNumber,
    operator,
    amount: rechargeAmount,
    status: 'success', // Mocking success
  });

  // Create Transaction Record
  await Transaction.create({
    senderId: user._id,
    type: 'recharge',
    amount: rechargeAmount,
    status: 'success',
    referenceId: `rech_${Date.now()}_${recharge._id.toString().substr(-5)}`,
  });

  // Create Wallet Log
  await WalletLog.create({
    userId: user._id,
    action: 'debit',
    amount: rechargeAmount,
    balanceAfter: user.walletBalance,
    description: `Mobile recharge for ${mobileNumber} (${operator})`,
  });

  if (req.io) req.io.emit('stock_update', { action: 'refresh' });

  res.json({ message: 'Recharge successful', recharge });
};

// @desc    Get user recharge history
// @route   GET /api/recharge/history
// @access  Private
const getRechargeHistory = async (req, res) => {
  const recharges = await Recharge.find({ userId: req.user._id }).sort({ createdAt: -1 });
  res.json(recharges);
};

module.exports = { rechargeMobile, getRechargeHistory };
