const mongoose = require('mongoose');

const fraudLogSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  action: { type: String, required: true }, // e.g., 'RAPID_TRANSACTIONS', 'IP_MISMATCH'
  scoreAdded: { type: Number, required: true },
  details: { type: String },
  ipAddress: { type: String },
  userAgent: { type: String }
}, { timestamps: true });

const FraudLog = mongoose.model('FraudLog', fraudLogSchema);
module.exports = FraudLog;
