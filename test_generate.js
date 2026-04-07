const mongoose = require('mongoose');
const User = require('./src/models/User');
const { generateVirtualSplits } = require('./src/controllers/stockController');

// Mock req, res
const mockReq = { 
  user: { _id: null },
  io: { emit: () => {} }
};
const mockRes = {
  json: (data) => console.log('RES_JSON:', data),
  status: function(code) { console.log('RES_STATUS:', code); return this; }
};

mongoose.connect('mongodb://localhost:27017/Hello_pay').then(async () => {
  const user = await User.findOne({});
  mockReq.user._id = user._id;
  await generateVirtualSplits(mockReq, mockRes);
  process.exit();
});
