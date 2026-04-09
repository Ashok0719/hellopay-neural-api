const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  phone: { type: String, unique: true, sparse: true },
  email: { type: String, unique: true, sparse: true },
  firebaseUid: { type: String, unique: true, sparse: true },
  profilePic: { type: String },
  password: { type: String }, 
  isOtpVerified: { type: Boolean, default: false },
  verifiedUpiId: { type: String },
  isSeller: { type: Boolean, default: false },
  userIdNumber: { type: Number, unique: true },
  walletBalance: { type: Number, default: 0 },
  rewardBalance: { type: Number, default: 0 },
  totalDeposited: { type: Number, default: 0 },
  totalWithdrawn: { type: Number, default: 0 },
  totalRewards: { type: Number, default: 0 },
  role: { type: String, enum: ['user', 'admin'], default: 'user' },
  isBlocked: { type: Boolean, default: false },
  referralCode: { type: String, unique: true, sparse: true },
  referredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  referralEarnings: { type: Number, default: 0 },
  referralCount: { type: Number, default: 0 },
  referralBonusAmount: { type: Number, default: 0 }, // ₹100 sign-up bonus, locked until deposit
  upiId: { type: String, unique: true, sparse: true }, // Ensured one UPI per global node
  isUpiVerified: { type: Boolean, default: false },
  upiModifiedAt: { type: Date },
  pin: { type: String, minlength: 4, maxlength: 4 },
  qrCode: { type: String },
  fraudScore: { type: Number, default: 0 },
  lastIp: { type: String },
  isSetupComplete: { type: Boolean, default: false },
  
  // Task Registry Telemetry
  dailyDepositAmount: { type: Number, default: 0 },
  weeklyDepositAmount: { type: Number, default: 0 },
  monthlyDepositAmount: { type: Number, default: 0 },
  dailyTaskGoal: { type: Number, default: 5000 },
  weeklyTaskGoal: { type: Number, default: 15000 },
  monthlyTaskGoal: { type: Number, default: 50000 },
  lastDailyClaimAt: { type: Date },
  lastWeeklyClaimAt: { type: Date },
  lastMonthlyClaimAt: { type: Date },
  taskLastUpdated: { type: Date },
  lastActive: { type: Date, default: Date.now },
  
  // Custom Profit Levels (Neural Overrides)
  referralPercent: { type: Number, default: 4 }, // Individual override, defaults to current global
  profitPercent: { type: Number, default: 8 },   // Individual override, defaults to current global
  isOpenSelling: { type: Boolean, default: false }, // Neural marketplace toggle
}, { timestamps: true });

userSchema.pre('save', async function () {
  if (!this.userIdNumber) {
    this.userIdNumber = Math.floor(100000 + Math.random() * 900000);
  }

  if (!this.referralCode) {
    this.referralCode = Math.random().toString(36).substring(2, 7).toUpperCase();
  }

  if (this.password && this.isModified('password')) {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
  }
});

userSchema.methods.matchPassword = async function (enteredPassword) {
  if (!this.password) return false;
  return await bcrypt.compare(enteredPassword, this.password);
};

const User = mongoose.model('User', userSchema);
module.exports = User;
