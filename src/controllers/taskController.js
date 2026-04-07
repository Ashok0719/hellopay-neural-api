const User = require('../models/User');

const isSameWeek = (d1, d2) => {
  const oneDay = 24 * 60 * 60 * 1000;
  const diff = Math.abs(d1 - d2);
  return diff < 7 * oneDay && d1.getDay() <= d2.getDay();
};

/**
 * Update task progress on internal deposit signal
 * @param {Object} user - User document
 * @param {Number} amount - The deposit amount confirmed
 */
const updateTaskProgress = async (user, amount) => {
  const now = new Date();
  const lastUpdate = user.taskLastUpdated || new Date(0);
  
  // Cycle Checks
  const isNewDay = now.toDateString() !== lastUpdate.toDateString();
  const isNewWeek = (isNewDay && now.getDay() === 1); // Monday Reset
  const isNewMonth = (isNewDay && now.getDate() === 1); // 1st Day Reset

  if (isNewDay) user.dailyDepositAmount = 0;
  if (isNewWeek) user.weeklyDepositAmount = 0;
  if (isNewMonth) user.monthlyDepositAmount = 0;

  user.dailyDepositAmount = (user.dailyDepositAmount || 0) + amount;
  user.weeklyDepositAmount = (user.weeklyDepositAmount || 0) + amount;
  user.monthlyDepositAmount = (user.monthlyDepositAmount || 0) + amount;
  user.taskLastUpdated = now;
  
  await user.save();
};

/**
 * @desc Get User Task Status
 * @route GET /api/tasks
 */
const getTasks = async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ message: 'Node not found' });

    // Ensure cycles are current even if no deposit happened today
    const now = new Date();
    const lastUpdate = user.taskLastUpdated || new Date(0);
    const isNewDay = now.toDateString() !== lastUpdate.toDateString();
    
    if (isNewDay) {
       user.dailyDepositAmount = 0;
       if (now.getDay() === 1) user.weeklyDepositAmount = 0;
       if (now.getDate() === 1) user.monthlyDepositAmount = 0;
       user.taskLastUpdated = now;
       await user.save();
    }

    res.json({
      daily: { current: user.dailyDepositAmount, goal: user.dailyTaskGoal, reward: 100, claimed: user.lastDailyClaimAt?.toDateString() === now.toDateString() },
      weekly: { current: user.weeklyDepositAmount, goal: user.weeklyTaskGoal, reward: 500, claimed: user.lastWeeklyClaimAt && isSameWeek(user.lastWeeklyClaimAt, now) },
      monthly: { current: user.monthlyDepositAmount, goal: user.monthlyTaskGoal, reward: 1000, claimed: user.lastMonthlyClaimAt && user.lastMonthlyClaimAt.getMonth() === now.getMonth() }
    });
  } catch (err) {
    res.status(500).json({ message: 'Server error retrieving task telemetry' });
  }
};

/**
 * @desc Claim Task Reward
 * @route POST /api/tasks/claim/:type
 */
const claimTask = async (req, res) => {
  try {
    const { type } = req.params;
    const user = await User.findById(req.user._id);
    const now = new Date();

    if (type === 'daily') {
      if (user.dailyDepositAmount < 5000) return res.status(400).json({ message: 'Goal not reached (0/5000)' });
      if (user.lastDailyClaimAt && user.lastDailyClaimAt.toDateString() === now.toDateString()) {
        return res.status(400).json({ message: 'Daily reward already processed for this cycle.' });
      }
      user.walletBalance += 100;
      user.lastDailyClaimAt = now;
    } else if (type === 'weekly') {
      if (user.weeklyDepositAmount < 15000) return res.status(400).json({ message: 'Goal not reached (0/15000)' });
      if (user.lastWeeklyClaimAt && isSameWeek(user.lastWeeklyClaimAt, now)) {
        return res.status(400).json({ message: 'Weekly reward already processed.' });
      }
      user.walletBalance += 500;
      user.lastWeeklyClaimAt = now;
    } else if (type === 'monthly') {
      if (user.monthlyDepositAmount < 50000) return res.status(400).json({ message: 'Goal not reached (0/50000)' });
      if (user.lastMonthlyClaimAt && user.lastMonthlyClaimAt.getMonth() === now.getMonth()) {
        return res.status(400).json({ message: 'Monthly reward already processed.' });
      }
      user.walletBalance += 1000;
      user.lastMonthlyClaimAt = now;
    } else {
       return res.status(400).json({ message: 'Invalid target cycle identified' });
    }

    await user.save();
    res.json({ message: 'Neural reward synchronized. Wallet balance increased.', walletBalance: user.walletBalance });
  } catch (err) {
    res.status(500).json({ message: 'Failed to process claim signal' });
  }
};

module.exports = {
  getTasks,
  claimTask,
  updateTaskProgress
};
