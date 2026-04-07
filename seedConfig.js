const mongoose = require('mongoose');
require('dotenv').config();
const Config = require('./src/models/Config');

const seedConfig = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('Connected to MongoDB');

    const existing = await Config.findOne({ key: 'SYSTEM_CONFIG' });
    if (!existing) {
      const defaultConfig = new Config({
        key: 'SYSTEM_CONFIG',
        stockPlans: [
          { amount: 100, code: 'H100X' },
          { amount: 200, code: 'H200X' },
          { amount: 300, code: 'H300X' },
          { amount: 400, code: 'H400X' },
          { amount: 500, code: 'H500S' },
          { amount: 1000, code: 'H1000S' },
          { amount: 5000, code: 'H5000P' },
          { amount: 10000, code: 'H10000E' }
        ],
        globalCashbackPercent: 4,
        adminExtraEnabled: true,
        adminProfitEnabled: true,
        depositEnabled: true,
        withdrawalEnabled: true,
        minDeposit: 100,
        maxDeposit: 50000
      });

      await defaultConfig.save();
      console.log('Default SYSTEM_CONFIG seeded successfully');
    } else {
      console.log('SYSTEM_CONFIG already exists');
    }

    mongoose.connection.close();
  } catch (err) {
    console.error('Seed failed:', err);
    process.exit(1);
  }
};

seedConfig();
