const mongoose = require('mongoose');
const User = require('./src/models/User');
const StockTransaction = require('./src/models/StockTransaction');
require('dotenv').config();

const patchDeposits = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/Hello_pay');
    
    // Process all users
    const users = await User.find({});
    
    for (let current of users) {
      // Find all successful purchases by this user
      const purchases = await StockTransaction.find({ 
        buyerId: current._id, 
        status: { $in: ['SUCCESS', 'VERIFIED'] } // in case VERIFIED was used instead of SUCCESS historically
      });
      
      let sumOfStockPurchases = 0;
      for (let tx of purchases) {
         sumOfStockPurchases += tx.amount;
      }
      
      // Calculate what they *should* have if we only sum purchases
      // Admin added value = their current totalDeposited (since stock transactions weren't added before)
      // So new totalDeposited = original totalDeposited + sumOfStockPurchases
      
      if (sumOfStockPurchases > 0) {
          const old = current.totalDeposited || 0;
          current.totalDeposited = old + sumOfStockPurchases;
          await current.save();
          console.log(`Updated user ${current.name} (${current.phone}): old deposit ${old}, added ${sumOfStockPurchases}. New total: ${current.totalDeposited}`);
      }
    }
    
    console.log('Patch complete.');
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
};

patchDeposits();
