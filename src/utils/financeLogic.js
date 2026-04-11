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
    // Neural activation rule: Referral bonus locks until first deposit >= minDeposit
    const minDeposit = config.minDeposit || 100;
    const lockedBonus = user.totalDeposited < minDeposit ? (user.referralBonusAmount || 0) : 0;
    const tradableBalance = Math.max(0, user.walletBalance - lockedBonus);
    
    const targetAmount = Math.floor(tradableBalance / 100) * 100;

    // ALWAYS clear available stocks to prevent duplicates and ensure 1:1 balance mapping
    await StockModel.deleteMany({ ownerId: userId, status: 'AVAILABLE' });
    let currentAvailableSum = 0;

    const deficit = targetAmount - currentAvailableSum;

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
      
      // Smart Neural Splitting: 
      // Instead of purely random, we pick from the largest 3 valid denominations
      // to keep the marketplace clean and prevent hyper-fragmentation.
      const topCount = Math.min(3, validDens.length);
      const randIdx = Math.floor(Math.random() * topCount);
      const chunk = validDens[randIdx];
      
      chunks.push(chunk);
      remaining -= chunk;
    }

    // Fragment assets into the new calculated nodes
    const stocksToCreate = [];
    const timestamp = Date.now();
    
    const generateShortId = () => {
      const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Avoid ambiguous chars like I, O, 0, 1
      let result = '';
      for (let j = 0; j < 5; j++) result += chars.charAt(Math.floor(Math.random() * chars.length));
      return result;
    };

    for (let i = 0; i < chunks.length; i++) {
      stocksToCreate.push({
        stockId: generateShortId(),
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

    return stocksToCreate;
  } catch (err) {
    console.error('[Neural Sync Error] Finance Logic Matrix Failed:', err);
    throw err;
  }
};


module.exports = { calculateFinancials, syncUserStocks };

