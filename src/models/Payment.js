const mongoose = require('mongoose');

const paymentSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  transactionId: { type: String, required: true, unique: true }, // Links to StockTransaction
  amount: { type: Number, required: true },
  utr: { type: String, unique: true, sparse: true },
  status: { 
    type: String, 
    enum: ['pending', 'success', 'failed', 'suspicious'], 
    default: 'pending' 
  },
  screenshotUrl: { type: String },
  verificationMethod: { 
    type: String, 
    enum: ['UTR', 'OCR', 'API', 'MANUAL'], 
    default: 'UTR' 
  },
  ocrData: {
    extractedAmount: Number,
    extractedUtr: String,
    matchStatus: Boolean
  },
  fraudScore: { type: Number, default: 0 },
  adminFlagged: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
}, { timestamps: true });

// Ensure UTR is unique and between 12-22 digits if provided
paymentSchema.pre('save', function(next) {
  if (this.utr && (this.utr.length < 12 || this.utr.length > 22)) {
    return next(new Error('UTR must be between 12 and 22 digits'));
  }
  next();
});

const Payment = mongoose.model('Payment', paymentSchema);
module.exports = Payment;
