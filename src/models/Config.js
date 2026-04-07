const mongoose = require('mongoose');

const configSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true }, // e.g., 'SYSTEM_CONFIG'
  stockPlans: [
    {
      amount: Number,
      code: { type: String, default: '' },
      isActive: { type: Boolean, default: true },
      splitEnabled: { type: Boolean, default: false },
      splitParts: [Number], // e.g., [500, 500] for ₹1000
      adminExtra: { type: Number, default: 100 },
    }
  ],
  globalCashbackPercent: { type: Number, default: 4 },
  profitPercentage: { type: Number, default: 4 },
  adminExtraEnabled: { type: Boolean, default: true },
  adminProfitEnabled: { type: Boolean, default: true },
  depositEnabled: { type: Boolean, default: true },
  minDeposit: { type: Number, default: 100 },
  maxDeposit: { type: Number, default: 15000 },
  withdrawalEnabled: { type: Boolean, default: true },
  withdrawalApprovalManual: { type: Boolean, default: true },
  splitDenominations: { type: [Number], default: [100, 500, 1000, 2000, 5000] },
  splitStrategy: { type: String, enum: ['AUTO', 'MANUAL'], default: 'AUTO' },
}, { timestamps: true });

const Config = mongoose.model('Config', configSchema);
module.exports = Config;
