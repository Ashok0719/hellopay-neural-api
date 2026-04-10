const mongoose = require('mongoose');

const stockTransactionSchema = new mongoose.Schema({
  transactionId: { type: String, unique: true, required: true },
  buyerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  sellerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  stockId: { type: mongoose.Schema.Types.ObjectId, ref: 'Stock', required: true },
  amount: { type: Number, required: true },
  utr: { type: String, unique: true, sparse: true },
  screenshot: { type: String },
  status: { type: String, enum: ['INIT', 'SUCCESS', 'FAILED', 'PENDING_REVIEW', 'FRAUD_FLAGGED', 'CANCELLED'], default: 'INIT' },
  isProcessed: { type: Boolean, default: false },
  confidenceScore: { type: Number, default: 0 },
  ocrData: { type: Object },
  flagReasons: { type: [String], default: [] },
  imageHash: { type: String },
}, { timestamps: true });

const StockTransaction = mongoose.model('StockTransaction', stockTransactionSchema);
module.exports = StockTransaction;
