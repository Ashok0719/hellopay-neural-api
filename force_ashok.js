const mongoose = require('mongoose');
async function run() {
  await mongoose.connect('mongodb://localhost:27017/Hello_pay');
  await mongoose.connection.db.collection('users').updateOne(
    { email: 'ashok@gmail.com' },
    { $set: { pin: '1234', name: 'Ashok Node', phone: '9998887766' } },
    { upsert: true }
  );
  console.log('ASHOK_PIN_LOCKED_1234');
  process.exit();
}
run();
