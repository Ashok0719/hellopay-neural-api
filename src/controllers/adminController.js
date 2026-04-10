  const Config = require('../models/Config');
  const User = require('../models/User');
  const Transaction = require('../models/Transaction');
  const Stock = require('../models/Stock');
  const StockTransaction = require('../models/StockTransaction');

  // Shared virtual-split helper (avoids code duplication)
  const { syncUserStocks } = require('../utils/financeLogic');
  const { updateTaskProgress } = require('./taskController');

  // Wrapper for controllers
  const rebuildVirtualSplits = async (userId, walletBalance, config, force = false) => {
    return await syncUserStocks(User, Stock, userId, walletBalance, config, force);
  };

  // @desc    Get full config for admin
  const getConfig = async (req, res) => {
    let config = await Config.findOne({ key: 'SYSTEM_CONFIG' });
    if (!config) {
      // Return a default blank config if nothing is in DB yet
      return res.json({
        key: 'SYSTEM_CONFIG',
        stockPlans: [],
        globalCashbackPercent: 4,
        profitPercentage: 4,
        adminProfitEnabled: true,
        depositEnabled: true,
        withdrawalEnabled: true
      });
    }
    res.json(config);
  };

  // @desc    Update system config
  const updateConfig = async (req, res) => {
    const { stockPlans, globalCashbackPercent, referralCommissionPercent, referralBonus, profitPercentage, adminExtraEnabled, adminProfitEnabled, depositEnabled, minDeposit, maxDeposit, withdrawalEnabled } = req.body;

    try {
      let config = await Config.findOne({ key: 'SYSTEM_CONFIG' });
      if (!config) {
        config = new Config({ key: 'SYSTEM_CONFIG' });
      }

      if (stockPlans) config.stockPlans = stockPlans;
      if (globalCashbackPercent !== undefined) config.globalCashbackPercent = globalCashbackPercent;
      if (referralCommissionPercent !== undefined) config.referralCommissionPercent = referralCommissionPercent;
      if (referralBonus !== undefined) config.referralBonus = referralBonus;
      if (profitPercentage !== undefined) config.profitPercentage = profitPercentage;
      if (adminExtraEnabled !== undefined) config.adminExtraEnabled = adminExtraEnabled;
      if (adminProfitEnabled !== undefined) config.adminProfitEnabled = adminProfitEnabled;
      if (depositEnabled !== undefined) config.depositEnabled = depositEnabled;
      if (minDeposit !== undefined) config.minDeposit = minDeposit;
      if (maxDeposit !== undefined) config.maxDeposit = maxDeposit;
      if (withdrawalEnabled !== undefined) config.withdrawalEnabled = withdrawalEnabled;

      await config.save();
      
      // Global Sync: Reflect changes on all users immediately as requested
      const updateData = {};
      if (globalCashbackPercent !== undefined) updateData.referralPercent = globalCashbackPercent;
      if (profitPercentage !== undefined) updateData.profitPercent = profitPercentage;
      
      if (Object.keys(updateData).length > 0) {
        await User.updateMany({}, { $set: updateData });
        console.log(`[Neural Sync] Propagated global limits to all users:`, updateData);
      }

      // Neural Signal: Emit the plain object version to avoid Mongoose serialization issues in Socket.io
      const syncData = {
        stockPlans: config.stockPlans,
        globalCashbackPercent: config.globalCashbackPercent,
        referralCommissionPercent: config.referralCommissionPercent,
        referralBonus: config.referralBonus,
        profitPercentage: config.profitPercentage,
        adminExtraEnabled: config.adminExtraEnabled,
        adminProfitEnabled: config.adminProfitEnabled,
        depositEnabled: config.depositEnabled,
        minDeposit: config.minDeposit,
        maxDeposit: config.maxDeposit,
        withdrawalEnabled: config.withdrawalEnabled
      };

      if (req.io) {
        req.io.emit('configUpdated', syncData);
        req.io.emit('userStatusChanged', { action: 'refresh' }); // Trigger frontend refresh for all users
      }
      res.json({ message: 'Configuration updated and propagated to all users successfully', config: syncData });
    } catch (err) {
      console.error('Neural Sync Failure:', err);
      res.status(500).json({ message: 'Update failed', error: err.message });
    }
  };

  // @desc    Get system analytics
  const getAnalytics = async (req, res) => {
    try {
      const totalUsers = await User.countDocuments();
      
      // Aggregate Transaction Data with safety for missing fields
      const txStats = await Transaction.aggregate([
        {
          $group: {
            _id: null,
            totalTransferred: { $sum: { $ifNull: ['$amount', 0] } },
            totalProfit: { $sum: { $ifNull: ['$split.adminExtra', 0] } },
            totalCashback: { $sum: { $ifNull: ['$cashback', 0] } },
            count: { $sum: 1 }
          }
        }
      ]);

      const stats = txStats[0] || { totalTransferred: 0, totalProfit: 0, totalCashback: 0, count: 0 };
      
      // Fraud Analytics
      const FraudLog = require('../models/FraudLog');
      const blockedCount = await User.countDocuments({ isBlocked: true });
    const fraudLogsCount = await FraudLog.countDocuments();

    res.json({
      totalUsers,
      totalTransactions: stats.count,
      totalTransferred: stats.totalTransferred,
      totalAdminProfit: stats.totalProfit,
      totalCashbackGiven: stats.totalCashback,
      blockedUsers: blockedCount,
      fraudAlerts: fraudLogsCount
    });
  } catch (err) {
    console.error('Analytics Fetch Error:', err);
    res.status(500).json({ message: 'Analytics fetch failed', error: err.message });
  }
};

// @desc    Get all users
const getAllUsers = async (req, res) => {
  const users = await User.find().select('-password').sort({ createdAt: -1 });
  res.json(users);
};

// @desc    Neural Termination: Delete user & all associated data
const deleteUser = async (req, res) => {
  try {
    const { id } = req.params;
    const user = await User.findById(id);
    if (!user) return res.status(404).json({ message: 'User Node Not Found' });

    // Atomic Cleanup: Assets & History (Non-blocking fault tolerance)
    try { await Stock.deleteMany({ ownerId: id }); } catch (e) {}
    try { await StockTransaction.deleteMany({ $or: [{ buyerId: id }, { sellerId: id }] }); } catch (e) {}
    try { await Transaction.deleteMany({ $or: [{ senderId: id }, { receiverId: id }] }); } catch (e) {}
    
    // Neural Wipe: Extended Data
    const FraudLog = require('../models/FraudLog');
    const WalletLog = require('../models/WalletLog');
    const Payment = require('../models/Payment');
    const Recharge = require('../models/Recharge');
    
    try { await FraudLog.deleteMany({ userId: id }); } catch (e) {}
    try { await WalletLog.deleteMany({ userId: id }); } catch (e) {}
    try { await Payment.deleteMany({ userId: id }); } catch (e) {}
    try { await Recharge.deleteMany({ userId: id }); } catch (e) {}
    
    await user.deleteOne();

    if (req.io) {
      req.io.emit('userDeleted', { userId: id });
      req.io.emit('userStatusChanged', { action: 'delete', userId: id });
      req.io.emit('stock_update', { action: 'refresh' });
    }

    res.json({ success: true, message: 'Entity Purged from Registry' });
  } catch (err) {
    console.error('Termination Failure:', err);
    res.status(500).json({ message: 'Termination sequence failed. Check Node connectivity.' });
  }
};

// @desc    Toggle user block
const toggleUserBlock = async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    
    user.isBlocked = !user.isBlocked;
    await user.save();
    
    // Emit real-time Neural Signal to propagate lockdown
    if (req.io) {
      req.io.emit('userStatusChanged', { 
        userId: user._id, 
        isBlocked: user.isBlocked 
      });
    }

    res.json({ 
      message: `User ${user.isBlocked ? 'blocked' : 'unblocked'} success`, 
      isBlocked: user.isBlocked,
      userId: user._id
    });
  } catch (err) {
    console.error('Lockdown Logic Failure (500 Error):', err);
    res.status(500).json({ 
      message: 'Internal Server Error during lockdown sequence', 
      error: err.message,
      stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
  }
};

// @desc    Manual user balance override (High-precision injection)
const updateUserBalance = async (req, res) => {
  try {
    const { id } = req.params;
    const { amount } = req.body;
    
    console.log(`[Neural Injection] Target: ${id}, Payload: ${amount} INR`);

    if (amount === undefined || isNaN(Number(amount))) {
      return res.status(400).json({ message: 'Invalid Neural Amount provided' });
    }

    const user = await User.findById(id);
    if (!user) {
       console.error(`[Neural Error] Node ${id} not found in repository`);
       return res.status(404).json({ message: 'User Node Not Found' });
    }

    const oldBalance = user.walletBalance;
    const newBalance = Number(amount);
    const delta = newBalance - oldBalance;

    user.walletBalance = newBalance;
    
    // Neural Signal: Apply Reward & Audit History
    const config = await Config.findOne({ key: 'SYSTEM_CONFIG' });
    let bonus = 0;

    if (delta > 0) {
      user.totalDeposited = (user.totalDeposited || 0) + delta;
      
      // Calculate Reward (Global Cashback Integration)
      bonus = Number((delta * (config?.globalCashbackPercent || 0) / 100).toFixed(2));
      if (bonus > 0) {
        user.rewardBalance = Number(((user.rewardBalance || 0) + bonus).toFixed(2));
        user.totalRewards = Number(((user.totalRewards || 0) + bonus).toFixed(2));
      }

      // Create Neural Transaction Audit Record
      try {
        await Transaction.create({
          senderId: user._id, 
          type: 'add_money',
          amount: delta,
          cashback: bonus,
          status: 'success',
          description: `Neural Injection: Admin Credit Target`,
          transactionId: `ADM-TX-${Date.now()}`
        });
      } catch (e) {
        console.warn('[Audit Warning] Transaction record creation failed, but balance was updated.');
      }
      
      // Neural Task Yield sync
      try {
        await updateTaskProgress(user, delta);
      } catch (e) {
        console.warn('[Audit Warning] Task progress sync failed.');
      }
    } else if (delta < 0) {
      user.totalWithdrawn = (user.totalWithdrawn || 0) + Math.abs(delta);
    }

    // Single save for atomicity
    await user.save();
    console.log(`[Neural Sync] Node ${id} balance updated: ${oldBalance} -> ${user.walletBalance}`);

    // Log the manual override in specific audit model
    try {
      const WalletLog = require('../models/WalletLog');
      await WalletLog.create({
        userId: user._id,
        action: user.walletBalance > oldBalance ? 'credit' : 'debit',
        amount: Math.abs(user.walletBalance - oldBalance),
        balanceAfter: user.walletBalance,
        description: `Administrative Adjustment: Neural Override${bonus > 0 ? ` (+₹${bonus} Reward)` : ''}`
      });
    } catch (logErr) {
      console.warn('[Audit Warning] Wallet signal logging failed, but balance was updated.');
    }

    // Neural Signal: Broadcast balance update & sync assets
    if (config) {
      try {
        await rebuildVirtualSplits(user._id, user.walletBalance, config);
      } catch (splitErr) {
        console.error('[Neural Fault] Virtual split reconstruction failed:', splitErr.message);
      }
    }

    if (req.io) {
      req.io.emit('userStatusChanged', { 
        userId: user._id, 
        walletBalance: user.walletBalance,
        isBlocked: user.isBlocked,
        totalDeposited: user.totalDeposited,
        totalWithdrawn: user.totalWithdrawn,
        rewardBalance: user.rewardBalance,
        totalRewards: user.totalRewards
      });
      // Broadcast stock update since splits were rebuilt
      req.io.emit('stock_update', { action: 'refresh' });
    }

    res.json({ 
      message: 'Neural Balance Synchronized', 
      walletBalance: user.walletBalance 
    });
  } catch (err) {
    console.error('[Neural Critical Error] Balance sync failure:', err);
    res.status(500).json({ message: `Internal Server Error: ${err.message}` });
  }
};

// @desc    Get all transactions for monitoring
const getAllTransactions = async (req, res) => {
  try {
    // 1. Fetch Legacy Static Transactions
    const txs = await Transaction.find()
      .populate('senderId', 'name userIdNumber')
      .populate('receiverId', 'name userIdNumber')
      .sort({ createdAt: -1 })
      .limit(100);

    // 2. Fetch P2P Neural Stock Transactions
    const stockTxs = await StockTransaction.find()
      .populate('buyerId', 'name userIdNumber')
      .populate('sellerId', 'name userIdNumber')
      .populate('stockId', 'stockId')
      .sort({ createdAt: -1 })
      .limit(100);

    // 3. Unify for Administration
    const unified = [
      ...txs.map(t => ({
        ...t._doc,
        category: (t.type === 'withdrawal' || t.action === 'debit') ? 'Purchase' : 'Receive',
        user: t.senderId || t.receiverId
      })),
      ...stockTxs.map(s => ({
        ...s._doc,
        type: 'ROTATION',
        category: 'Purchase/Receive', // Mixed since it involves two users
        description: `P2P Neural Rotation: ${s.stockId?.stockId || 'ID_' + s._id}`,
        buyer: s.buyerId,
        seller: s.sellerId,
        user: s.buyerId // For admin list view mapping
      }))
    ].sort((a,b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    res.json(unified);
  } catch (err) {
    res.status(500).json({ message: 'Neural History Extraction Failed', error: err.message });
  }
};

// @desc    Approve or reject a pending transaction
const reviewTransaction = async (req, res) => {
  try {
    const { id, action } = req.params;
    const transaction = await Transaction.findById(id);
    if (!transaction) return res.status(404).json({ message: 'Transaction not found' });
    if (transaction.status !== 'PENDING') return res.status(400).json({ message: 'Transaction already processed' });

    const user = await User.findById(transaction.senderId);
    if (!user) return res.status(404).json({ message: 'User owner not found' });

    const config = await Config.findOne({ key: 'SYSTEM_CONFIG' });

    if (action === 'approve') {
      if (transaction.type === 'add_money' || transaction.type === 'buy_stock') {
        user.walletBalance += transaction.amount;
        user.totalDeposited = (user.totalDeposited || 0) + transaction.amount;
        
        // Task Progress Signal Integration
        await updateTaskProgress(user, transaction.amount);
        
        // Referral Commission Integration
        if (user.referredBy) {
          const referrer = await User.findById(user.referredBy);
          if (referrer) {
             const commPercent = referrer.referralPercent || config?.referralCommissionPercent || config?.globalCashbackPercent || 4;
             const comm = Number((transaction.amount * commPercent / 100).toFixed(2));
             referrer.walletBalance = Number((referrer.walletBalance + comm).toFixed(2));
             referrer.referralEarnings = Number(((referrer.referralEarnings || 0) + comm).toFixed(2));
             await referrer.save();
             await rebuildVirtualSplits(referrer._id, referrer.walletBalance, config);
             if (req.io) req.io.emit('userStatusChanged', { userId: referrer._id, walletBalance: referrer.walletBalance });
          }
        }

        // Apply default cashback
        const bonus = (transaction.amount * (config?.globalCashbackPercent || 0)) / 100;
        if (bonus > 0) {
          user.rewardBalance = (user.rewardBalance || 0) + bonus;
          user.totalRewards = (user.totalRewards || 0) + bonus;
        }
      } else if (transaction.type === 'withdrawal') {
        user.totalWithdrawn = (user.totalWithdrawn || 0) + transaction.amount;
        // Balance was already deducted during requestWithdrawal
      }
      
      transaction.status = 'SUCCESS';
      await user.save();
    } else if (action === 'reject') {
      // Refund if it was a withdrawal
      if (transaction.type === 'withdrawal') {
        user.walletBalance += transaction.amount;
        await user.save();
        
        // Create Refund Log
        const WalletLog = require('../models/WalletLog');
        await WalletLog.create({
          userId: user._id,
          action: 'credit',
          amount: transaction.amount,
          balanceAfter: user.walletBalance,
          description: `Withdrawal Rejected - Refund: ₹${transaction.amount}`,
        });
      }
      transaction.status = 'FAILED';
    }

    await transaction.save();
    res.json({ message: `Transaction ${action}d successfully`, status: transaction.status });
  } catch (err) {
    res.status(500).json({ message: 'Review action failed' });
  }
};

// @desc    Admin Initialize Stock
const initializeStock = async (req, res) => {
  try {
    const { amount } = req.body;
    const adminUser = req.user;
    
    if(!adminUser.upiId) {
      return res.status(400).json({ success: false, message: 'Admin must set upiId first before creating stocks' });
    }

    const stock = await Stock.create({
      stockId: 'STK' + Date.now(),
      amount,
      ownerId: adminUser._id,
      ownerUpiId: adminUser.upiId,
      ownerQrCode: adminUser.qrCode,
      status: 'AVAILABLE'
    });

    req.io.emit('stock_update', { action: 'added', stock });

    res.json({ success: true, stock });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc    Admin Verify Stock Transaction
const adminVerifyStockTransaction = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body; // 'SUCCESS' or 'FAILED'

    const transaction = await StockTransaction.findById(id);
    if (!transaction) return res.status(404).json({ message: 'Transaction not found' });
    
    if (!['PENDING_PAYMENT', 'PENDING_VERIFICATION', 'FAILED', 'INIT', 'PENDING_REVIEW'].includes(transaction.status)) {
      return res.status(400).json({ message: 'Transaction already processed or completed' });
    }

    if (status === 'SUCCESS') {
      // 1. Double Processing Check & Reference Mapping
      const sessionTransaction = await StockTransaction.findOneAndUpdate(
        { _id: id, isProcessed: false },
        { 
          $set: { 
            status: 'SUCCESS', 
            isProcessed: true, 
            referenceId: 'ADMIN-VERIFIED-' + Date.now() 
          } 
        },
        { new: true }
      );

      if (!sessionTransaction || sessionTransaction.status !== 'SUCCESS') {
        return res.status(400).json({ message: 'Transaction already processed or failed' });
      }

      // 2. Consistent Stock Status Update (Virtual Unit SOLD)
      const stock = await Stock.findOneAndUpdate(
        { _id: sessionTransaction.stockId, status: { $ne: 'SOLD' } },
        { $set: { status: 'SOLD' } },
        { new: true }
      );
      if (!stock) return res.status(400).json({ message: 'Stock already sold' });

      // 3. BUYER: Get record first for percentages
      const buyer = await User.findById(transaction.buyerId);
      if (!buyer) return res.status(404).json({ message: 'Buyer node not found' });

      const config = await Config.findOne({ key: 'SYSTEM_CONFIG' });
      const profitPercentage = buyer.profitPercent || config?.profitPercentage || 8;

      // 4. SELLER: Finalize Node Liquidation (Bank Credit Simulation)
      const seller = await User.findById(sessionTransaction.sellerId);
      if (seller) {
        const oldSellerBalance = seller.walletBalance;
        seller.walletBalance = Number((seller.walletBalance - sessionTransaction.amount).toFixed(2));
        if (seller.walletBalance < 0) seller.walletBalance = 0;
        await seller.save();

        // Simulate Bank Credit (System Log)
        const WalletLog = require('../models/WalletLog');
        await WalletLog.create({
          userId: seller._id,
          action: 'debit',
          amount: sessionTransaction.amount,
          balanceAfter: seller.walletBalance,
          description: `Virtual Node Liquidation: ₹${sessionTransaction.amount} credited to user bank (Simulated)`
        });

        await rebuildVirtualSplits(seller._id, seller.walletBalance, config);
        
        if (req.io) {
          req.io.emit('userStatusChanged', { 
            userId: seller._id, 
            walletBalance: seller.walletBalance 
          });
        }
      }

      // 5. Apply credit amount + profit, rebuild splits
      const profit      = Number((sessionTransaction.amount * profitPercentage / 100).toFixed(2));
      const walletIncrease = Number((sessionTransaction.amount + profit).toFixed(2));
      buyer.walletBalance  = Number((buyer.walletBalance + walletIncrease).toFixed(2));
      
      // Capturing Node Profit as a Reward Signal
      buyer.totalRewards = Number(((buyer.totalRewards || 0) + profit).toFixed(2));
      
      await buyer.save();
      await rebuildVirtualSplits(buyer._id, buyer.walletBalance, config);

      // --- REFERRAL COMMISSION (4%) ---
      if (buyer.referredBy) {
        const referrer = await User.findById(buyer.referredBy);
        if (referrer) {
          const commPercent = referrer.referralPercent || config.referralCommissionPercent || config.globalCashbackPercent || 4;
          const commission = Number((sessionTransaction.amount * commPercent / 100).toFixed(2));
          referrer.walletBalance = Number((referrer.walletBalance + commission).toFixed(2));
          referrer.referralEarnings = Number(((referrer.referralEarnings || 0) + commission).toFixed(2));
          await referrer.save();

          // Sync referrers stocks (real-time conversion)
          await syncUserStocks(User, Stock, referrer._id, referrer.walletBalance, config);

          if (req.io) {
            req.io.emit('userStatusChanged', { 
              userId: referrer._id, 
              walletBalance: referrer.walletBalance 
            });
            req.io.emit('stock_update', { action: 'refresh' });
          }
        }
      }

      req.io.emit('stock_update', { action: 'rotation_complete' });
      res.json({ success: true, message: 'Transaction manually verified — virtual rotation complete' });
    } else {
      transaction.status = 'FAILED';
      await transaction.save();

      if (req.io) req.io.emit('userStatusChanged', { action: 'transaction_failed', transactionId: id });

      const stock = await Stock.findById(transaction.stockId);
      stock.status = 'AVAILABLE';
      stock.lockedUntil = null;
      await stock.save();

      req.io.emit('stock_update', { action: 'unlocked', stockId: stock._id });
      res.json({ success: true, message: 'Transaction manually rejected' });
    }

  } catch (err) {
    res.status(500).json({ message: 'Verification action failed', error: err.message });
  }
};

// @desc    Admin Stock Management: Get all active stocks (Filtered for valid owners)
const getAllStocks = async (req, res) => {
  try {
    const stocks = await Stock.find({ 
      ownerId: { $exists: true }, // Must have a valid user node
      amount: { $gt: 0 }           // Must have real wallet backing
    })
      .populate('ownerId', 'name userIdNumber')
      .populate('selectedBy', 'name')
      .sort({ isPinned: -1, createdAt: -1 });
    res.json(stocks);
  } catch (err) {
    res.status(500).json({ message: 'Stock fetch failed' });
  }
};

// @desc    Admin Stock Management: Permanent Data Deletion
const deleteStock = async (req, res) => {
  try {
    const { id } = req.params;
    const stock = await Stock.findByIdAndDelete(id);
    if (!stock) return res.status(404).json({ message: 'Neural Node Not Found' });

    // Global Neural Signal: Remove from all dashboards
    if (req.io) req.io.emit('stock_update', { action: 'refresh', deletedId: id });
    res.json({ success: true, message: 'Stock Node Terminated' });
  } catch (err) {
    res.status(500).json({ message: 'Neural Deletion Failed' });
  }
};

const toggleStockPin = async (req, res) => {
  try {
    const { id } = req.params;
    const stock = await Stock.findById(id);
    if (!stock) return res.status(404).json({ message: 'Stock not found' });
    stock.isPinned = !stock.isPinned;
    await stock.save();
    if (req.io) req.io.emit('stock_update', { action: 'refresh' });
    res.json({ success: true, isPinned: stock.isPinned });
  } catch (err) {
    res.status(500).json({ message: 'Pin toggle failed' });
  }
};

// @desc    Admin: Delete transaction record permanently
const deleteTransaction = async (req, res) => {
  try {
    const { id } = req.params;
    let deleted = await Transaction.findByIdAndDelete(id);
    if (!deleted) {
       deleted = await StockTransaction.findByIdAndDelete(id);
    }
    if (!deleted) return res.status(404).json({ message: 'Transaction node not found in any ledger' });
    res.json({ success: true, message: 'Transaction identity purged from matrix' });
  } catch (err) {
    res.status(500).json({ message: 'Neural Purge Failed' });
  }
};

// @desc    Admin: Force resplit user wallet
const resplitUserWallet = async (req, res) => {
  try {
    const { id } = req.params;
    const user = await User.findById(id);
    if (!user) return res.status(404).json({ message: 'Entity Not Found' });
    const config = await Config.findOne({ key: 'SYSTEM_CONFIG' }) || {};

    const created = await rebuildVirtualSplits(user._id, user.walletBalance, config, true);

    if (req.io) req.io.emit('stock_update', { action: 'splits_generated', userId: user._id });
    res.json({ success: true, message: `Rebuilt ${created.length} virtual split units for ${user.name}` });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// @desc    Admin: Override user splits with custom values
const overrideWalletSplits = async (req, res) => {
  try {
    const { id } = req.params;
    const { splits } = req.body;
    
    if (!Array.isArray(splits) || splits.length === 0) {
      return res.status(400).json({ message: 'Neural Fault: Splits array required' });
    }

    const user = await User.findById(id);
    if (!user) return res.status(404).json({ message: 'Entity Not Found' });

    // Validate the total split amount isn't larger than usable balance
    const totalSplit = splits.reduce((sum, val) => sum + Number(val), 0);
    const lockedBonus = user.totalDeposited < 100 ? (user.referralBonusAmount || 0) : 0;
    const tradableBalance = Math.max(0, user.walletBalance - lockedBonus);

    if (totalSplit > tradableBalance) {
      return res.status(400).json({ message: `Neural Fault: Total split amount (₹${totalSplit}) exceeds tradable balance (₹${tradableBalance})` });
    }

    // 1. Purge existing available inventory
    await Stock.deleteMany({ ownerId: user._id, status: 'AVAILABLE' });

    // 2. Inject custom fragments
    const stocksToCreate = [];
    const timestamp = Date.now();
    for (let i = 0; i < splits.length; i++) {
       stocksToCreate.push({
         stockId: `STK${timestamp}${i}${Math.floor(Math.random() * 10000)}`,
         amount: Number(splits[i]),
         ownerId: user._id,
         ownerUpiId: user.upiId || 'admin@upi',
         ownerQrCode: user.qrCode || '',
         status: 'AVAILABLE',
         isPinned: false
       });
    }

    if (stocksToCreate.length > 0) {
      await Stock.insertMany(stocksToCreate);
    }

    // Neural Sync Broadcast
    if (req.io) req.io.emit('stock_update', { action: 'splits_generated', userId: user._id });
    
    res.json({ success: true, message: `Successfully injected ${stocksToCreate.length} custom split units into the mesh.` });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// @desc    Admin Fraud Monitoring Dashboard
const getFraudDashboard = async (req, res) => {
  try {
    const flaggedTransactions = await StockTransaction.find({
      status: { $in: ['FRAUD_FLAGGED', 'PENDING_REVIEW'] }
    })
    .populate('buyerId', 'name userIdNumber phone')
    .sort({ createdAt: -1 });

    const formattedData = flaggedTransactions.map(tx => ({
      userId: tx.buyerId?._id,
      userName: tx.buyerId?.name,
      userIdNumber: tx.buyerId?.userIdNumber,
      transactionId: tx.transactionId,
      utr: tx.utr || 'Not provided',
      screenshotUrl: tx.screenshot || 'None',
      confidenceScore: tx.confidenceScore,
      riskLevel: tx.ocrData?.riskLevel || 'Unknown',
      flagReasons: tx.ocrData?.flagReasons || [],
      transparencyLogs: tx.transparencyLogs,
      status: tx.status,
      timestamp: tx.createdAt
    }));

    res.json({ success: true, flaggedTransactions: formattedData });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to access fraud data layer' });
  }
};

// @desc    Admin: Update individual user profit/referral percentages
const updateUserPercents = async (req, res) => {
  try {
    const { id } = req.params;
    const { referralPercent, profitPercent } = req.body;
    
    const user = await User.findById(id);
    if (!user) return res.status(404).json({ message: 'User Entity Not Found' });

    if (referralPercent !== undefined) user.referralPercent = referralPercent;
    if (profitPercent !== undefined) user.profitPercent = profitPercent;

    await user.save();
    
    if (req.io) {
      req.io.emit('userStatusChanged', { 
        userId: user._id, 
        referralPercent: user.referralPercent,
        profitPercent: user.profitPercent
      });
    }

    res.json({ success: true, message: 'Neural Percentages Calibrated', user });
  } catch (err) {
    res.status(500).json({ message: 'Calibration Failure' });
  }
};

const bulkUserAction = async (req, res) => {
  try {
    const { ids, action } = req.body;
    if (!ids || !Array.isArray(ids)) return res.status(400).json({ message: 'Invalid entity set' });

    console.log(`[Neural Bulk] Initiating ${action} for ${ids.length} nodes`);

    if (action === 'delete') {
      const Stock = require('../models/Stock');
      const StockTransaction = require('../models/StockTransaction');
      const Transaction = require('../models/Transaction');
      const FraudLog = require('../models/FraudLog');
      const WalletLog = require('../models/WalletLog');
      const Payment = require('../models/Payment');
      const Recharge = require('../models/Recharge');

      await Stock.deleteMany({ ownerId: { $in: ids } });
      await StockTransaction.deleteMany({ $or: [{ buyerId: { $in: ids } }, { sellerId: { $in: ids } }] });
      await Transaction.deleteMany({ $or: [{ senderId: { $in: ids } }, { receiverId: { $in: ids } }] });
      await FraudLog.deleteMany({ userId: { $in: ids } });
      await WalletLog.deleteMany({ userId: { $in: ids } });
      await Payment.deleteMany({ userId: { $in: ids } });
      await Recharge.deleteMany({ userId: { $in: ids } });
      await User.deleteMany({ _id: { $in: ids } });
    } else if (action === 'block') {
      await User.updateMany({ _id: { $in: ids } }, { isBlocked: true });
    } else if (action === 'unblock') {
      await User.updateMany({ _id: { $in: ids } }, { isBlocked: false });
    }

    if (req.io) {
      req.io.emit('configUpdated');
      req.io.emit('stock_update', { action: 'refresh' });
    }

    res.json({ success: true, message: `Neural Bulk ${action} completed for ${ids.length} nodes.` });
  } catch (err) {
    console.error('Bulk Action Failure:', err);
    res.status(500).json({ message: 'Neural Bulk sequence failed' });
  }
};

module.exports = { 
  getConfig, updateConfig, getAnalytics, getAllUsers, toggleUserBlock, 
  updateUserBalance, deleteUser, getAllTransactions, reviewTransaction, 
  initializeStock, adminVerifyStockTransaction, getAllStocks, toggleStockPin,
  deleteStock, deleteTransaction, resplitUserWallet, overrideWalletSplits,
  getFraudDashboard, updateUserPercents,
  bulkUserAction
};
