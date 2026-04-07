const mongoose = require('mongoose');
const User = require('./src/models/User');
require('dotenv').config();

const fixDeposits = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/Hello_pay');

    const users = await User.find({});
    
    console.log('--- Current User States ---');
    for (let u of users) {
      console.log(`User: ${u.name} | Wallet: ₹${u.walletBalance} | totalDeposited: ₹${u.totalDeposited || 0} | totalWithdrawn: ₹${u.totalWithdrawn || 0}`);
      
      // If totalDeposited is zero/missing but they have a wallet balance, sync it
      if ((!u.totalDeposited || u.totalDeposited === 0) && u.walletBalance > 0) {
        u.totalDeposited = u.walletBalance;
        await u.save();
        console.log(`  ✅ Fixed: Set totalDeposited = ₹${u.walletBalance}`);
      }
    }

    console.log('\nDone!');
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
};

fixDeposits();
