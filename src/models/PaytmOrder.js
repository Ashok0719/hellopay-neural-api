const mongoose = require('mongoose');

const paytmOrderSchema = new mongoose.Schema({
  orderId: { type: String, required: true, unique: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  amount: { type: Number, required: true },
  txnToken: { type: String },
  txnId: { type: String }, // Transaction ID from Paytm
  status: {
    type: String,
    enum: ["PENDING", "SUCCESS", "FAILED"],
    default: "PENDING",
  },
}, { timestamps: true });

module.exports = mongoose.model('PaytmOrder', paytmOrderSchema);
