const mongoose = require('mongoose');

const rechargeSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  mobileNumber: { type: String, required: true },
  operator: { type: String, required: true },
  amount: { type: Number, required: true },
  status: {
    type: String,
    enum: ['pending', 'success', 'failed'],
    default: 'pending',
  },
}, { timestamps: true });

const Recharge = mongoose.model('Recharge', rechargeSchema);
module.exports = Recharge;
