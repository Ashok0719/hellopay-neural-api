const mongoose = require('mongoose');

const walletLogSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  action: { type: String, enum: ['credit', 'debit', 'gift_code'], required: true },
  amount: { type: Number, required: true },
  balanceAfter: { type: Number, required: true },
  description: { type: String },
}, { timestamps: true });

const WalletLog = mongoose.model('WalletLog', walletLogSchema);
module.exports = WalletLog;
