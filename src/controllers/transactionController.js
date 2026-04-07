const mongoose = require('mongoose');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const WalletLog = require('../models/WalletLog');

// @desc    Transfer money between users
// @route   POST /api/transactions/transfer
// @access  Private
const transferMoney = async (req, res) => {
  const { receiverPhone, amount } = req.body;
  const transferAmount = Number(amount);

  if (transferAmount <= 0) {
    res.status(400);
    throw new Error('Invalid amount');
  }

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const sender = await User.findById(req.user._id).session(session);
    const receiver = await User.findOne({ phone: receiverPhone }).session(session);

    if (!receiver) {
      throw new Error('Receiver not found');
    }

    if (sender._id.equals(receiver._id)) {
      throw new Error('Cannot transfer to yourself');
    }

    if (sender.walletBalance < transferAmount) {
      throw new Error('Insufficient balance');
    }

    // Update balances
    sender.walletBalance -= transferAmount;
    receiver.walletBalance += transferAmount;

    await sender.save({ session });
    await receiver.save({ session });

    // Create Transaction Record
    const transaction = await Transaction.create([{
      senderId: sender._id,
      receiverId: receiver._id,
      type: 'transfer',
      amount: transferAmount,
      status: 'success',
      referenceId: `txn_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
    }], { session });

    // Create Wallet Logs
    await WalletLog.create([{
      userId: sender._id,
      action: 'debit',
      amount: transferAmount,
      balanceAfter: sender.walletBalance,
      description: `Transferred to ${receiver.name}`,
    }], { session });

    await WalletLog.create([{
      userId: receiver._id,
      action: 'credit',
      amount: transferAmount,
      balanceAfter: receiver.walletBalance,
      description: `Received from ${sender.name}`,
    }], { session });

    await session.commitTransaction();
    session.endSession();

    res.json({ message: 'Transfer successful', transaction });
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    res.status(400);
    throw new Error(error.message);
  }
};

const StockTransaction = require('../models/StockTransaction');

// @desc    Get user transaction history (Unified Purchase & Receive)
// @route   GET /api/transactions/history
// @access  Private
const getTransactionHistory = async (req, res) => {
  try {
    const userId = req.user._id;

    // 1. Fetch Legacy Transactions (Static transfers/deposits)
    const txs = await Transaction.find({
      $or: [{ senderId: userId }, { receiverId: userId }]
    })
    .populate('senderId', 'name userIdNumber')
    .populate('receiverId', 'name userIdNumber')
    .sort({ createdAt: -1 })
    .limit(50);

    // 2. Fetch Neural P2P Stock Transactions (Market activity)
    const stockTxs = await StockTransaction.find({
      $or: [{ buyerId: userId }, { sellerId: userId }]
    })
    .populate('buyerId', 'name userIdNumber')
    .populate('sellerId', 'name userIdNumber upiId')
    .populate('stockId', 'stockId')
    .sort({ createdAt: -1 })
    .limit(50);

    // 3. Unify & Format for Frontend
    const unified = [
      ...txs.map(t => ({
        ...t._doc,
        category: (t.type === 'withdrawal' || t.action === 'debit') ? 'Purchase' : 'Receive',
        direction: (t.senderId?._id?.toString() === userId.toString()) ? 'OUT' : 'IN'
      })),
      ...stockTxs.map(s => {
        const isBuyer = s.buyerId?._id?.toString() === userId.toString();
        // Neural Status Mapping: User Friendly Labels
        let displayStatus = s.status;
        if (s.status === 'INIT') {
           const startTime = new Date(s.createdAt).getTime();
           const currentTime = Date.now();
           if (currentTime - startTime > 20 * 60 * 1000) displayStatus = 'TIMEOUT';
           else displayStatus = 'PENDING';
        } else if (s.status === 'SUCCESS') displayStatus = 'COMPLETED';
        else if (s.status === 'FAILED') displayStatus = 'CANCELED';
        else if (s.status === 'CANCELLED') displayStatus = 'CANCELED';

        return {
          ...s._doc,
          type: 'ROTATION',
          category: isBuyer ? 'Purchase' : 'Receive',
          direction: isBuyer ? 'OUT' : 'IN',
          description: isBuyer ? `Stock Bought: ${s.stockId?.stockId || 'ID_' + s._id}` : `Stock Sold: ${s.stockId?.stockId || 'ID_' + s._id}`,
          otherParty: isBuyer ? s.sellerId : s.buyerId,
          status: displayStatus // Overwrite with clear term
        };
      })
    ].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    res.json(unified);
  } catch (error) {
    res.status(500).json({ message: 'Neural History Extraction Failed', error: error.message });
  }
};

module.exports = { transferMoney, getTransactionHistory };
