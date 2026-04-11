const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '.env') });

const Stock = require('./src/models/Stock');

const generateShortId = () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let result = '';
  for (let j = 0; j < 5; j++) result += chars.charAt(Math.floor(Math.random() * chars.length));
  return result;
};

async function migrate() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('Connected to Neural Database for ID Migration...');

    const stocks = await Stock.find({});
    console.log(`Found ${stocks.length} stocks. Cleaning up long identifiers...`);

    let count = 0;
    for (const stock of stocks) {
      if (stock.stockId.length > 8) { // If it's a long ID or NODE XXXXX
        stock.stockId = generateShortId();
        await stock.save();
        count++;
      }
    }

    console.log(`Migration Complete: ${count} stock IDs shortened to 5-character alphanumeric format.`);
    process.exit(0);
  } catch (err) {
    console.error('Migration Failed:', err);
    process.exit(1);
  }
}

migrate();
