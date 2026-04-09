const mongoose = require('mongoose');

const stockTransactionSchema = new mongoose.Schema({
  transactionId: { type: String, required: true, unique: true },
  stockId: { type: mongoose.Schema.Types.ObjectId, ref: 'Stock', required: true },
  buyerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  sellerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  amount: { type: Number, required: true },
  referenceId: { type: String },
  screenshot: { type: String },
  status: { type: String, enum: ['INIT', 'SUCCESS', 'FAILED', 'PENDING_REVIEW', 'CANCELLED', 'TIMEOUT', 'FRAUD_FLAGGED'], default: 'INIT' },
  upiId: { type: String }, // UPI ID used for payment
  utr: { type: String, unique: true, sparse: true },
  ocrData: {
    extractedAmount: { type: Number },
    extractedUtr: { type: String },
    extractedDate: { type: String },
    extractedReceiver: { type: String },
    flagReasons: [{ type: String }],
    riskLevel: { type: String }
  },
  confidenceScore: { type: Number, default: 0 },
  adminNotes: { type: String },
  isProcessed: { type: Boolean, default: false },
  imageHash: { type: String }, // For duplicate image detection
  transparencyLogs: {
    scoreBreakdown: { type: Object },
    validationResults: { type: Object },
    decisionReason: { type: String }
  }
}, { timestamps: true });

const StockTransaction = mongoose.model('StockTransaction', stockTransactionSchema);
module.exports = StockTransaction;
