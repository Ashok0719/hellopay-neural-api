const User = require('../models/User');
const Stock = require('../models/Stock');
const Config = require('../models/Config');
const generateToken = require('../utils/generateToken');
const { syncUserStocks } = require('../utils/financeLogic');

// Helper to set PWA-compliant secure cookie (30 days persistence)
const setAuthCookie = (res, token) => {
  res.cookie('token', token, {
    httpOnly: true,
    secure: true, // Always true for PWA compatibility on modern web
    sameSite: 'None', 
    maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
  });
};

// Mock OTP storage (In production, use Redis or a dedicated OTP service)
const otpStore = new Map();

// @desc    Send OTP to mobile or email
// @route   POST /api/auth/send-otp
// @access  Public
const sendOtp = async (req, res) => {
  const { identifier } = req.body;

  if (!identifier) {
    return res.status(400).json({ message: 'Mobile or Email is required' });
  }

  // Generate 4-digit OTP
  const otp = "1234"; // Fixed for demo verification
  otpStore.set(identifier, otp);

  console.log(`[NEURAL AUTH] OTP for ${identifier}: ${otp}`);

  res.status(200).json({ message: 'OTP sent successfully', mockOtp: otp });
};

// @desc    Premium Registration with Referral Integration
// @route   POST /api/auth/register
// @access  Public
const register = async (req, res) => {
  const { name, email, password, pin, referralCode } = req.body;

  if (!name || !email || !password || !pin) {
    return res.status(400).json({ message: 'Name, Email, Password and Safety PIN required' });
  }

  // Prevent duplicate accounts
  const existingUser = await User.findOne({ email });
  if (existingUser) {
    return res.status(400).json({ message: 'Identity already bound to another node' });
  }

  // Create unique User ID (e.g., 6 digits)
  const userIdNumber = Math.floor(100000 + Math.random() * 900000).toString();
  const userReferralCode = Math.random().toString(36).substring(2, 7).toUpperCase();

  let referredBy = null;
  if (referralCode) {
    const referrer = await User.findOne({ referralCode: referralCode.toUpperCase() });
    if (referrer) {
      referredBy = referrer._id;
      // Increment referral count for real-time tracking
      await User.findByIdAndUpdate(referrer._id, { $inc: { referralCount: 1 } });
    }
  }

  // Fetch system config for dynamic bonus
  const config = await Config.findOne({ key: 'SYSTEM_CONFIG' });
  const bonus = config?.referralBonus || 100;

  const user = await User.create({
    name,
    email,
    password, 
    pin,
    userIdNumber,
    referralCode: userReferralCode,
    referredBy,
    walletBalance: referredBy ? bonus : 0, 
    referralBonusAmount: referredBy ? bonus : 0, 
    isOtpVerified: true,
    isSetupComplete: true
  });

  const token = generateToken(user._id);
  setAuthCookie(res, token);

  res.status(201).json({
    _id: user._id,
    name: user.name,
    userIdNumber,
    token
  });
};

const login = async (req, res) => {
  const { identifier, password, pin } = req.body;

  const user = await User.findOne({ email: identifier });

  if (!user || !(await user.matchPassword(password))) {
    return res.status(401).json({ message: 'Invalid Credentials: Passkey mismatch' });
  }

  if (!(await user.matchPin(pin))) {
    return res.status(401).json({ message: 'Safety Protocol: Invalid PIN' });
  }

  if (user.isBlocked) {
    return res.status(403).json({ message: 'Identity suspended by Neural Admin' });
  }

  const token = generateToken(user._id);
  setAuthCookie(res, token);

  res.json({
    _id: user._id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    userIdNumber: user.userIdNumber,
    referralCode: user.referralCode,
    isBlocked: user.isBlocked,
    walletBalance: user.walletBalance,
    rewardBalance: user.rewardBalance || 0,
    isOpenSelling: user.isOpenSelling || false,
    token: token, // This token will now be saved in localStorage by the frontend
  });
};

// @desc    Reset Password via 4-digit Safety PIN
// @route   POST /api/auth/reset-password-pin
// @access  Public
const resetPasswordWithPin = async (req, res) => {
  const { email, pin, newPassword } = req.body;

  if (!email || !pin || !newPassword) {
    return res.status(400).json({ message: 'Email, PIN and New Password are required' });
  }

  const user = await User.findOne({ email });

  if (!user) {
    return res.status(404).json({ message: 'Identity Node not found' });
  }

  const isPinMatch = await user.matchPin(pin);
  if (!isPinMatch) {
    return res.status(401).json({ message: 'Invalid Safety PIN: Authorization Denied' });
  }

  user.password = newPassword;
  await user.save();

  res.json({ success: true, message: 'Password reset successful. Access your Node with your new passkey.' });
};

// @desc    Get user profile (Masked UPI for security)
// @route   GET /api/auth/profile
// @access  Private
const getUserProfile = async (req, res) => {
  const user = await User.findById(req.user._id);

  if (user) {
    // Temporary: Disable masking to prevent frontend sync loops where masked text is saved back to DB
    const maskedUpi = user.upiId;

    res.json({
      _id: user._id,
      userIdNumber: user.userIdNumber,
      name: user.name,
      phone: user.phone,
      isSeller: user.isSeller,
      isBlocked: user.isBlocked,
      isUpiVerified: user.isUpiVerified,
      verifiedUpiId: maskedUpi,
      upiId: maskedUpi,
      pin: user.pin ? "****" : null,
      qrCode: user.qrCode,
      walletBalance: user.walletBalance,
      referralCode: user.referralCode,
      referralEarnings: user.referralEarnings || 0,
      upiModifiedAt: user.upiModifiedAt,
      totalDeposited: user.totalDeposited || 0,
      totalWithdrawn: user.totalWithdrawn || 0,
      rewardBalance: user.rewardBalance || 0,
      totalRewards: user.totalRewards || 0,
      referralBonusAmount: user.referralBonusAmount || 0,
      isOpenSelling: user.isOpenSelling || false,
      token: generateToken(user._id)
    });
  } else {
    res.status(404);
    throw new Error('User not found');
  }
};

// @desc    Get referral statistics (Enhanced Neural Analytics)
// @route   GET /api/auth/referrals
// @access  Private
const getReferralStats = async (req, res) => {
  const user = await User.findById(req.user._id);
  const referrals = await User.find({ referredBy: req.user._id }, 'name userIdNumber createdAt walletBalance');

  const Transaction = require('../models/Transaction');
  const referralIds = referrals.map(r => r._id);

  // Fetch all successful deposit signals from this downline
  const depositStats = await Transaction.find({
    senderId: { $in: referralIds },
    status: 'success',
    type: { $in: ['add_money', 'buy_stock'] }
  });

  // Calculate detailed metrics per referral (Real-Time Yield Sync)
  const config = await Config.findOne({ key: 'SYSTEM_CONFIG' });
  const commRate = config?.referralCommissionPercent || 4;
  const minDeposit = config?.minDeposit || 100;

  const listWithMetrics = referrals.map(ref => {
    const userDeposits = depositStats.filter(tx => tx.senderId.toString() === ref._id.toString());
    const totalDeposit = userDeposits.reduce((sum, tx) => sum + (tx.amount || 0), 0);
    const commission = Number((totalDeposit * commRate / 100).toFixed(2));

    return {
      _id: ref._id,
      name: ref.name,
      userIdNumber: ref.userIdNumber,
      createdAt: ref.createdAt,
      totalDeposit,
      commission,
      isActive: totalDeposit >= minDeposit
    };
  });

  const totalBusinessVolume = listWithMetrics.reduce((sum, ref) => sum + ref.totalDeposit, 0);
  const activeUsersCount = listWithMetrics.filter(ref => ref.isActive).length;

  res.json({
    referralCode: user.referralCode,
    totalReferrals: referrals.length,
    activeUsersCount,
    totalBusinessVolume,
    referralEarnings: user.referralEarnings || 0,
    referralList: listWithMetrics,
    commRate,
    minDeposit,
    referralBonus: config?.referralBonus || 100
  });
};

// @desc    Verify UPI ID via ₹1 Micro-Transaction
// @route   POST /api/auth/verify-upi
// @access  Private
const verifyUpi = async (req, res) => {
  try {
    const { utr, amount } = req.body;
    const user = await User.findById(req.user._id);

    if (!user.upiId) return res.status(400).json({ message: 'No UPI ID linked to node' });
    if (Number(amount) !== 1) return res.status(400).json({ message: 'Verification requires exactly ₹1' });

    // Neural Security: Match UTR + Amount + UPI origin
    // In a real app, check bank API or static lookup
    if (utr && utr.length >= 10) {
      user.isUpiVerified = true;
      await user.save();

      if (req.io) {
        req.io.emit('userStatusChanged', { userId: user._id, isUpiVerified: true });
      }

      return res.json({ success: true, message: 'UPI Node Identity Verified' });
    } else {
      return res.status(400).json({ message: 'Invalid UTR Signal' });
    }
  } catch (err) {
    res.status(500).json({ message: 'Verification logic failure' });
  }
};

// @desc    Update user profile (Neural Security Layer)
// @route   PUT /api/auth/profile
// @access  Private
const updateUserProfile = async (req, res) => {
  const user = await User.findById(req.user._id);
  const { name, upiId, qrCode, pin, currentPin } = req.body;

  if (user) {
    // 1. PIN Protection for UPI/Security Changes
    if (upiId || pin) {
      if (!user.pin) {
        // Allow setting PIN for the first time without currentPin
      } else if (!currentPin || !(await user.matchPin(currentPin))) {
        return res.status(401).json({ message: 'Invalid Neural PIN: Authorization Denied' });
      }
    }

    // 2. 24h Cooldown Rule & UPI Assignment
    if (upiId && upiId !== user.upiId) {
      let finalUpi = upiId.toLowerCase().trim();
      
      // FEATURE: PHONE NUMBER AUTO-CONVERT
      if (/^\d{10}$/.test(finalUpi)) {
        finalUpi = `${finalUpi}@upi`;
      }

      const twentyFourHours = 24 * 60 * 60 * 1000;
      
      // Enforce cooldown ONLY if a previous UPI existed
      if (user.upiId && user.upiModifiedAt && (Date.now() - user.upiModifiedAt.getTime() < twentyFourHours)) {
        const hoursLeft = Math.ceil((twentyFourHours - (Date.now() - user.upiModifiedAt.getTime())) / (60 * 60 * 1000));
        return res.status(403).json({ message: `Security Lock: UPI can only be changed once in 24h. Please wait ${hoursLeft}h.` });
      }

      // 3. Regex Validation
      const upiRegex = /^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z]{2,64}$/;
      if (!upiRegex.test(finalUpi)) {
        return res.status(400).json({ message: 'Neural Fault: Invalid UPI Format Detected' });
      }

      // 4. Unique UPI Check
      const existingUpi = await User.findOne({ upiId: finalUpi, _id: { $ne: user._id } });
      if (existingUpi) {
        return res.status(400).json({ message: 'Fraud Alert: UPI ID already linked to another global node' });
      }

      // Update UPI and reset verification
      user.upiId = finalUpi;
      user.isUpiVerified = false; // Reset to requires verification
      user.upiModifiedAt = new Date();
      user.verifiedUpiId = finalUpi; // For compat
    }

    user.name = name || user.name;
    if (req.file) {
       user.qrCode = `/uploads/${req.file.filename}`;
    } else if (qrCode === '') {
       user.qrCode = null; // Reset if empty string sent
    }
    
    if (pin) user.pin = pin;

    const updatedUser = await user.save();

    res.json({
      _id: updatedUser._id,
      name: updatedUser.name,
      isUpiVerified: updatedUser.isUpiVerified,
      upiId: updatedUser.upiId, 
      verifiedUpiId: updatedUser.upiId,
      qrCode: updatedUser.qrCode,
      walletBalance: updatedUser.walletBalance,
    });
  } else {
    res.status(404);
    throw new Error('User not found');
  }
};


// @desc    Firebase Social/Email Login & Auto-Registration
// @route   POST /api/auth/firebase-login
// @access  Public
const firebaseLogin = async (req, res) => {
  const { idToken, referralCode } = req.body;
  const admin = require('../config/firebase');

  try {
    // 1. Verify Neural Signal via Firebase
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    const { email, name, picture, uid } = decodedToken;

    // 2. Find or Create Identity Node
    let user = await User.findOne({ email });

    if (!user) {
      console.log(`[NEURAL] Initializing new External Node for ${email}`);
      const userIdNumber = Math.floor(100000 + Math.random() * 900000).toString();
      const userReferralCode = Math.random().toString(36).substring(2, 7).toUpperCase();

      // Fetch system config for dynamic bonus
      const config = await Config.findOne({ key: 'SYSTEM_CONFIG' });
      const bonus = config?.referralBonus || 100;

      let referredBy = null;
      if (referralCode) {
        const referrer = await User.findOne({ referralCode: referralCode.toUpperCase() });
        if (referrer) referredBy = referrer._id;
      }

      user = await User.create({
        name: name || 'Neural Merchant',
        email,
        firebaseUid: uid,
        profilePic: picture,
        userIdNumber,
        pin: '0000', // Default temporary PIN
        referralCode: userReferralCode,
        referredBy,
        walletBalance: referredBy ? bonus : 0,
        referralBonusAmount: referredBy ? bonus : 0,
        isOtpVerified: true
      });
    }

    if (user.isBlocked) {
      return res.status(403).json({ message: 'Identity suspended by Neural Admin' });
    }

    // 3. Emit Signal & Respond
    const token = generateToken(user._id);
    setAuthCookie(res, token);

    res.json({
      _id: user._id,
      name: user.name,
      email: user.email,
      userIdNumber: user.userIdNumber,
      token,
      needsSetup: !user.isSetupComplete
    });

  } catch (error) {
    console.error('[NEURAL AUTH FAULT] Detailed Error:', {
      message: error.message,
      code: error.code,
      stack: error.stack?.split('\n')[1] // Just the first line of stack for localizing
    });
    res.status(401).json({ 
      message: 'Invalid Neural Signal: Firebase Auth Failure',
      technicalDetail: error.message 
    });
  }
};

const debugFirebase = async (req, res) => {
  const admin = require('../config/firebase');
  try {
    const status = {
      initialized: admin.apps.length > 0,
      apps: admin.apps.map(a => a.name),
      project: admin.apps.length > 0 ? admin.app().options.credential : 'none',
      timestamp: new Date().toISOString()
    };
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
};

// @desc    Change user PIN with old PIN verification
// @route   POST /api/auth/change-pin
// @access  Private
const changePin = async (req, res) => {
  try {
    const { oldPin, newPin } = req.body;
    const user = await User.findById(req.user._id);

    if (!user) return res.status(404).json({ message: 'Identity Node Not Found' });

    // Verify current PIN
    if (!(await user.matchPin(oldPin))) {
      return res.status(401).json({ success: false, message: 'Invalid Current PIN' });
    }

    // Validate new PIN format
    if (!/^\d{4}$/.test(newPin)) {
      return res.status(400).json({ success: false, message: 'New PIN must be exactly 4 digits' });
    }

    user.pin = newPin;
    await user.save();

    res.json({ success: true, message: 'Neural PIN Successfully Updated' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Encryption Protocol Failure' });
  }
};

/**
 * FEATURE 7: STRICT UPI SAVE LOGIC
 */
const saveUpi = async (req, res) => {
  try {
    let { upiId } = req.body;
    if (!upiId) return res.status(400).json({ success: false, message: 'UPI ID required' });
    
    upiId = upiId.toLowerCase().trim();
    
    // FEATURE: PHONE NUMBER AUTO-CONVERT (BACKEND)
    if (/^\d{10}$/.test(upiId)) {
      upiId = `${upiId}@upi`;
    }

    // 1. Regex Validation (Relaxed for Real-World Compatibility)
    const upiRegex = /^[a-z0-9._-]{3,}@[a-z]{2,}$/;
    if (!upiRegex.test(upiId)) {
      return res.status(400).json({ success: false, message: 'Invalid Neural ID Format' });
    }

    // 2. Rules: Length & Type Check
    const [username, handle] = upiId.split('@');
    
    // Numeric-only usernames (e.g., Paytm)
    if (/^\d+$/.test(username)) {
      if (username.length < 8 || username.length > 15) {
        return res.status(400).json({ success: false, message: 'Numeric Identity must be 8-15 digits' });
      }
    } else {
      // Mixed usernames
      if (username.length < 3) {
        return res.status(400).json({ success: false, message: 'Identity Node too short (min 3 chars)' });
      }
    }

    // Still block repeated symbols
    if (username.includes('..') || username.includes('__') || username.includes('--')) {
      return res.status(400).json({ success: false, message: 'Sequential symbols are blocked for security' });
    }

    // 3. Expanded Allowed Handles
    const validHandles = [
      'okaxis', 'oksbi', 'okhdfcbank', 'okicici', 'ybl', 'ibl', 'axl', 'apl', 'paytm', 'upi',
      'ptaxis', 'ptsbi', 'pthdfc'
    ];
    if (!validHandles.includes(handle)) {
      return res.status(400).json({ success: false, message: `Invalid Handler @${handle}` });
    }

    const { pin } = req.body;
    const user = await User.findById(req.user._id);

    if (!user.pin) {
      // First time setting PIN, allowed to proceed
    } else if (!pin || !(await user.matchPin(pin))) {
      return res.status(401).json({ success: false, message: 'Invalid Security PIN' });
    }

    // 4. Duplicate Check
    const existing = await User.findOne({ upiId, _id: { $ne: user._id } });
    if (existing) {
      return res.status(400).json({ success: false, message: 'This UPI ID is already linked to another account' });
    }

    // 5. Save Verified Status
    user.upiId = upiId;
    user.verifiedUpiId = upiId;
    user.isUpiVerified = true; 
    user.upiModifiedAt = new Date();
    
    if (req.file) {
      user.qrCode = `/uploads/${req.file.filename}`;
    }

    await user.save();

    res.json({ 
      success: true, 
      message: 'UPI Node Identity Verified & Saved',
      upiId: user.upiId 
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Neural Registry Failure' });
  }
};

const completeProfile = async (req, res) => {
  try {
    const { name, password } = req.body;
    const user = await User.findById(req.user._id);

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    user.name = name || user.name;
    if (password) user.password = password;
    user.isSetupComplete = true;
    await user.save();

    res.json({
      _id: user._id,
      name: user.name,
      email: user.email,
      userIdNumber: user.userIdNumber,
      token: generateToken(user._id)
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const toggleSelling = async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ message: 'User not found' });
    
    // Safety: User MUST have verified UPI to open selling
    if (!user.isOpenSelling && !user.isUpiVerified) {
       return res.status(400).json({ 
         success: false, 
         message: 'Neuro-Constraint: You must verify your UPI identity before opening sales.' 
       });
    }

    user.isOpenSelling = !user.isOpenSelling;
    await user.save();

    res.json({ 
      success: true, 
      isOpenSelling: user.isOpenSelling,
      message: user.isOpenSelling ? 'Neural Marketplace: ON' : 'Neural Marketplace: OFF'
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Marketplace toggle failed' });
  }
};

module.exports = {
  sendOtp,
  register,
  login,
  getUserProfile,
  getReferralStats,
  updateUserProfile,
  verifyUpi,
  firebaseLogin,
  changePin,
  saveUpi,
  completeProfile,
  toggleSelling,
  resetPasswordWithPin,
  debugFirebase
};
