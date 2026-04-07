const mongoose = require('mongoose');

const stockSchema = new mongoose.Schema({
  stockId: { type: String, required: true, unique: true },
  amount: { type: Number, required: true },
  ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  ownerUpiId: { type: String, required: true },
  ownerQrCode: { type: String },
  status: { type: String, enum: ['AVAILABLE', 'SOLD', 'LOCKED'], default: 'AVAILABLE' },
  lockedUntil: { type: Date },
  isPinned: { type: Boolean, default: false },
  selectedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  selectionExpires: { type: Date }
}, { timestamps: true });

const Stock = mongoose.model('Stock', stockSchema);
module.exports = Stock;
