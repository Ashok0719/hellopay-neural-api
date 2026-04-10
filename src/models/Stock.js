const mongoose = require('mongoose');

const stockSchema = new mongoose.Schema({
  stockId: { type: String, required: true, unique: true },
  ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  amount: { type: Number, required: true },
  status: { type: String, enum: ['AVAILABLE', 'LOCKED', 'SOLD'], default: 'AVAILABLE' },
  selectedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  selectionExpires: { type: Date, default: null },
  lockedUntil: { type: Date, default: null },
  isPinned: { type: Boolean, default: false },
  originalAmount: { type: Number },
}, { timestamps: true });

const Stock = mongoose.model('Stock', stockSchema);
module.exports = Stock;
