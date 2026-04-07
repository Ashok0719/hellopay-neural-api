const mongoose = require('mongoose');
const User = require('./src/models/User');
const Stock = require('./src/models/Stock');
const { syncUserStocks } = require('./src/utils/financeLogic');

mongoose.connect('mongodb://localhost:27017/Hello_pay').then(async () => {
  try {
    const user = await User.findOne({ walletBalance: { $gt: 100 } });
    if (!user) {
      console.log('no user');
      process.exit();
    }
    console.log('Testing for user', user.name, user.walletBalance);
    await syncUserStocks(User, Stock, user._id, user.walletBalance, {});
    console.log('success');
  } catch(e) {
    console.error('ERROR_THROWN:', e.stack);
  }
  process.exit();
});
