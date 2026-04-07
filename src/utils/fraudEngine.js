const User = require('../models/User');
const FraudLog = require('../models/FraudLog');

/**
 * Neural AI Fraud Detection Engine
 * Behavior-based analysis for account integrity
 */
const auditUserBehavior = async (userId, action, scoreDelta, req, details = '') => {
  try {
    const user = await User.findById(userId);
    if (!user) return;

    // 1. IP Behavior Detection
    const currentIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
    if (user.lastIp && user.lastIp !== currentIp) {
       // Detected IP change mid-session or across sessions
       scoreDelta += 10; 
       
       // Check if this IP is used by another ID (Same IP check)
       const ipCount = await User.countDocuments({ lastIp: currentIp, _id: { $ne: userId } });
       if (ipCount > 0) scoreDelta += 20; 
    }

    // 2. Temporal Behavior (Rapid Transactions)
    const now = new Date();
    const timeDiff = now - (user.lastActive || now);
    if (timeDiff < 10000 && (action === 'STOCK_BUY' || action === 'OTP_VERIFY')) { // 10 sec threshold
       scoreDelta += 15;
    }

    // Update Scores
    user.fraudScore = Math.min(100, user.fraudScore + scoreDelta);
    user.lastIp = currentIp;
    user.lastActive = now;

    // Logic: Auto-block if score > 75
    if (user.fraudScore > 75) {
      user.isBlocked = true;
      console.log(`[FRAUD] AUTO-BLOCK Triggered for User ${userId}. Score: ${user.fraudScore}`);
    }

    await user.save();

    // Log the event
    await FraudLog.create({
      userId: user._id,
      action,
      scoreAdded: scoreDelta,
      details: `${details} (TimeDiff: ${timeDiff}ms)`,
      ipAddress: currentIp,
      userAgent: req.headers['user-agent']
    });

    if (req.io && user.isBlocked) {
       req.io.emit('userStatusChanged', { userId: user._id, isBlocked: true });
    }

    return user.fraudScore;
  } catch (err) {
    console.error('Fraud Engine Failure:', err);
  }
};

module.exports = { auditUserBehavior };
