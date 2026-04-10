const mongoose = require('mongoose');

const paymentSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  transactionId: { type: mongoose.Schema.Types.ObjectId, ref: 'StockTransaction' },
  amount: { type: Number, required: true },
  utr: { type: String, unique: true, sparse: true },
  status: { type: String, enum: ['pending', 'success', 'failed'], default: 'pending' },
  verificationMethod: { type: String },
}, { timestamps: true });

const Payment = mongoose.model('Payment', paymentSchema);
module.exports = Payment;
