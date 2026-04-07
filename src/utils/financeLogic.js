/**
 * Logic for calculating final user splits, admin extra and cashback
 * @param {Number} amount - The deposit amount
 * @param {Object} config - The system configuration from DB
 */
const calculateFinancials = (amount, config) => {
  // 1. Find custom rule if it exists
  const customRule = config.stockPlans.find(plan => plan.amount === amount);
  
  let userParts = [];
  let adminExtra = 0;
  let cashback = (amount * config.globalCashbackPercent) / 100;

  if (customRule && customRule.splitEnabled) {
    userParts = customRule.splitParts;
    adminExtra = customRule.adminExtra;
  } else {
    // Default Logic
    if (amount < 500) {
      userParts = [amount]; // No split
      adminExtra = 100;
    } else {
      // Amount >= 500
      userParts = [amount / 2, amount / 2]; // 50/50 split
      adminExtra = 100;
    }
  }

  // Check global toggles
  if (!config.adminExtraEnabled) adminExtra = 0;

  return {
    userParts,
    adminExtra,
    cashback
  };
};

/**
 * Neural 2.0 Identity-Bound Split Logic
 * @desc Syncs user wallet balance into virtual split units
 */
const syncUserStocks = async (UserModel, StockModel, userId, walletBalance, config = {}, forceResplit = false) => {
  try {
    const user = await UserModel.findById(userId);
    if (!user) throw new Error('Neural Node Not Registered');

    // Expected tradable amount (must be multiples of ₹100)
    // Neural activation rule: Referral bonus locks until first deposit >= 100
    const lockedBonus = user.totalDeposited < 100 ? (user.referralBonusAmount || 0) : 0;
    const tradableBalance = Math.max(0, user.walletBalance - lockedBonus);
    
    const targetAmount = Math.floor(tradableBalance / 100) * 100;

    let availableStocks = await StockModel.find({ ownerId: userId, status: 'AVAILABLE' });
    let currentAvailableSum = availableStocks.reduce((sum, s) => sum + s.amount, 0);

    // If forced to resplit by admin, or if current available config is severely mismatched, we drop them.
    if (forceResplit || (currentAvailableSum > targetAmount)) {
      // Simplest way to reconcile if we have more available than we should (e.g. they transferred out or bought)
      // or if admin requested a clean slate:
      await StockModel.deleteMany({ ownerId: userId, status: 'AVAILABLE' });
      availableStocks = [];
      currentAvailableSum = 0;
    }

    const deficit = targetAmount - currentAvailableSum;

    if (deficit <= 0) {
      // Nothing to create, IDs are preserved perfectly!
      return availableStocks;
    }

    // We must generate splits equal to `deficit`
    const chunks = [];
    let remaining = deficit;
    
    // Neural Smart Splitting - Nice round denominations up to 50k
    const denominations = [
      50000, 20000, 10000, 5000, 4000, 3000, 2000, 1000, 
      900, 800, 700, 600, 500, 400, 300, 200, 100
    ];

    while (remaining >= 100) {
      const validDens = denominations.filter(d => d <= remaining);
      if (validDens.length === 0) break;
      
      // Pick a random valid denomination (bias towards slightly mixing them up)
      // We take a random index from the valid possibilities to create mixed values (100, 200, 500, etc.)
      const randIdx = Math.floor(Math.random() * validDens.length);
      const chunk = validDens[randIdx];
      chunks.push(chunk);
      remaining -= chunk;
    }

    // Fragment assets into the new calculated nodes
    const stocksToCreate = [];
    const timestamp = Date.now();
    
    for (let i = 0; i < chunks.length; i++) {
      stocksToCreate.push({
        stockId: `STK${timestamp}${i}${Math.floor(Math.random() * 10000)}`,
        amount: chunks[i],
        ownerId: userId,
        ownerUpiId: user.upiId || 'admin@upi',
        ownerQrCode: user.qrCode || '',
        status: 'AVAILABLE',
        isPinned: false
      });
    }

    if (stocksToCreate.length > 0) {
      // Chunk insertions for very high balances to prevent packet size errors
      const insertLimit = 100;
      for (let i = 0; i < stocksToCreate.length; i += insertLimit) {
        const chunk = stocksToCreate.slice(i, i + insertLimit);
        await StockModel.insertMany(chunk);
      }
    }

    return [...availableStocks, ...stocksToCreate];
  } catch (err) {
    console.error('[Neural Sync Error] Finance Logic Matrix Failed:', err);
    throw err;
  }
};


module.exports = { calculateFinancials, syncUserStocks };

