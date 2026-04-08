const express = require('express');
const router = express.Router();
const { 
  sendOtp, 
  register, 
  login, 
  getUserProfile, 
  getReferralStats, 
  updateUserProfile, 
  loginGuest, 
  verifyUpi,
  firebaseLogin
} = require('../controllers/authController');
const { protect } = require('../middleware/authMiddleware');
const { otpValidation } = require('../middleware/validator');
const { upload } = require('../middleware/uploadMiddleware');

router.post('/send-otp', sendOtp);
router.post('/register', register);
router.post('/login', login);
router.post('/firebase-login', firebaseLogin);
router.post('/verify-otp', otpValidation, login); // Fallback for existing clients
router.post('/guest', loginGuest);
router.post('/verify-upi', protect, verifyUpi);
router.get('/profile', protect, getUserProfile);
router.put('/profile', protect, upload.single('qrCode'), updateUserProfile);
router.get('/referrals', protect, getReferralStats);

module.exports = router;
