const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema({
  senderId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  receiverId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  listingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Listing' },
  type: {
    type: String,
    enum: ['transfer', 'recharge', 'add_money', 'plan_purchase', 'buy_stock', 'withdrawal'],
    required: true,
  },
  amount: { type: Number, required: true },
  commissionAmount: { type: Number, default: 0 },
  split: {
    adminProfit: { type: Number, default: 0 },
    adminExtra: { type: Number, default: 0 },
  },
  cashback: { type: Number, default: 0 },
  rewardUsed: { type: Number, default: 0 },
  status: {
    type: String,
    enum: ['PENDING', 'SUCCESS', 'FAILED', 'REJECTED'],
    default: 'PENDING',
  },
  screenshotUrl: { type: String },
  transactionId: { type: String, unique: true, sparse: true }, // UPI Ref Number
  isOcrVerified: { type: Boolean, default: false },
  referenceId: { type: String, unique: true, sparse: true }, // Internal order ID
  deviceId: { type: String }, // APK Device ID for safety binding
  ipAddress: { type: String }, // Identity tracking
  description: { type: String },
}, { timestamps: true });

const Transaction = mongoose.model('Transaction', transactionSchema);
module.exports = Transaction;
