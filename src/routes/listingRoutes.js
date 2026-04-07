const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const { createListing, getListings, claimListing, uploadReceipt } = require('../controllers/listingController');
const { protect } = require('../middleware/authMiddleware');

// Multer Storage Config
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    cb(null, `${req.user._id}-${Date.now()}${path.extname(file.originalname)}`);
  }
});

const upload = multer({ storage });

router.route('/')
  .post(protect, createListing)
  .get(getListings);

router.post('/:id/claim', protect, claimListing);
router.post('/upload-receipt', protect, upload.single('screenshot'), uploadReceipt);

module.exports = router;
