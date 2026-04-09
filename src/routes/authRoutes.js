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
  completeProfile
} = require('../controllers/authController');
const { protect } = require('../middleware/authMiddleware');
const { otpValidation } = require('../middleware/validator');
const { upload } = require('../middleware/uploadMiddleware');

router.post('/send-otp', sendOtp);
router.post('/register', register);
router.post('/login', login);
router.post('/firebase-login', firebaseLogin);
router.post('/verify-otp', otpValidation, login); 
router.post('/verify-upi', protect, verifyUpi);
router.get('/profile', protect, getUserProfile);
router.get('/me', protect, getUserProfile);
router.put('/profile', protect, upload.single('qrCode'), updateUserProfile);
router.get('/referrals', protect, getReferralStats);
router.post('/change-pin', protect, changePin);
router.post('/complete-profile', protect, completeProfile);

module.exports = router;
