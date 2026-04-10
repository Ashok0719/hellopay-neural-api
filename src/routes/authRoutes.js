const express = require('express');
const router = express.Router();
const { 
  sendOtp, 
  register, 
  login, 
  getUserProfile, 
  getReferralStats, 
  updateUserProfile, 
  verifyUpi,
  firebaseLogin,
  changePin,
  completeProfile,
  toggleSelling,
  resetPasswordWithPin,
  debugFirebase
} = require('../controllers/authController');
const { protect } = require('../middleware/authMiddleware');
const { otpValidation } = require('../middleware/validator');
const { upload } = require('../middleware/uploadMiddleware');

router.post('/send-otp', sendOtp);
router.post('/register', register);
router.post('/login', login);
router.post('/reset-password-pin', resetPasswordWithPin);
router.post('/firebase-login', firebaseLogin);
router.get('/debug-firebase', debugFirebase);
router.post('/verify-otp', otpValidation, login); 
router.post('/verify-upi', protect, verifyUpi);
router.get('/profile', protect, getUserProfile);
router.get('/me', protect, getUserProfile);
router.put('/profile', protect, upload.single('qrCode'), updateUserProfile);
router.get('/referrals', protect, getReferralStats);
router.post('/change-pin', protect, changePin);
router.post('/complete-profile', protect, completeProfile);
router.post('/toggle-selling', protect, toggleSelling);

module.exports = router;
