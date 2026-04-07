const Listing = require('../models/Listing');
const Transaction = require('../models/Transaction');
const User = require('../models/User');
const Stock = require('../models/Stock');
const { extractTransactionDetails, verifyPaymentData } = require('../utils/ocrService');
const { syncUserStocks } = require('../utils/financeLogic');
const { updateTaskProgress } = require('./taskController');

// @desc    Create a new stock listing
// @route   POST /api/listings
// @access  Private
const createListing = async (req, res) => {
  const { stockName, price, quantity, sellerUpiId, qrCodeImage } = req.body;

  if (!stockName || !price || !quantity || !sellerUpiId) {
    return res.status(400).json({ message: 'All fields are required' });
  }

  const listing = await Listing.create({
    stockName,
    price,
    quantity,
    sellerUpiId,
    qrCodeImage,
    sellerId: req.user._id,
  });

  await User.findByIdAndUpdate(req.user._id, { isSeller: true });
  res.status(201).json(listing);
};

// @desc    Get all active listings
// @route   GET /api/listings
// @access  Public
const getListings = async (req, res) => {
  const listings = await Listing.find({ status: 'ACTIVE', quantity: { $gt: 0 } })
    .populate('sellerId', 'name');
  res.json(listings);
};

// @desc    Initiate a claim/purchase
// @route   POST /api/listings/:id/claim
// @access  Private
const claimListing = async (req, res) => {
  const listing = await Listing.findById(req.params.id);

  if (!listing || listing.status !== 'ACTIVE' || listing.quantity <= 0) {
    return res.status(404).json({ message: 'Listing not available' });
  }

  const orderId = `DIWA_${Math.random().toString(36).substring(2, 10).toUpperCase()}`;

  const transaction = await Transaction.create({
    senderId: req.user._id,
    receiverId: listing.sellerId,
    listingId: listing._id,
    type: 'buy_stock',
    amount: listing.price,
    status: 'pending',
    referenceId: orderId,
  });

  const upiIntent = `upi://pay?pa=${listing.sellerUpiId}&pn=HELLOPAY_SELLER&am=${listing.price}&cu=INR&tn=${orderId}`;

  res.json({
    message: 'Claim initiated',
    orderId,
    amount: listing.price,
    sellerUpiId: listing.sellerUpiId,
    upiIntent,
    transactionId: transaction._id
  });
};

// @desc    Upload payment screenshot and verify via OCR
// @route   POST /api/listings/upload-receipt
// @access  Private
const uploadReceipt = async (req, res) => {
  const { transactionId } = req.body;
  
  if (!req.file) {
    return res.status(400).json({ message: 'No screenshot uploaded' });
  }

  const transaction = await Transaction.findById(transactionId).populate('listingId');
  if (!transaction) {
    return res.status(404).json({ message: 'Transaction not found' });
  }

  const screenshotPath = req.file.path;
  transaction.screenshotUrl = screenshotPath;
  await transaction.save();

  console.log(`[BOT] Analyzing screenshot for Transaction: ${transaction.referenceId}`);
  const ocrData = await extractTransactionDetails(screenshotPath);

  if (!ocrData) {
    return res.status(400).json({ message: 'OCR failed to read screenshot. Please wait for manual review.' });
  }

  const verification = verifyPaymentData(ocrData, {
    amount: transaction.amount,
    sellerUpiId: transaction.listingId.sellerUpiId
  });

  transaction.isOcrVerified = verification.success;
  transaction.transactionId = ocrData.transactionId;

  if (verification.success) {
    const user = await User.findById(transaction.senderId);
    user.walletBalance += transaction.amount;
    user.totalDeposited = (user.totalDeposited || 0) + transaction.amount;
    
    // Task Progress Signal Integration
    await updateTaskProgress(user, transaction.amount);
    
    // Apply cashback if applicable
    const config = await Config.findOne({ key: 'SYSTEM_CONFIG' });
    const bonus = (transaction.amount * (config?.globalCashbackPercent || 0)) / 100;
    if (bonus > 0) {
      user.rewardBalance = (user.rewardBalance || 0) + bonus;
      user.totalRewards = (user.totalRewards || 0) + bonus;
    }

    // Referral Commission Integration (4% on Deposit)
    if (user.referredBy) {
      const referrer = await User.findById(user.referredBy);
      if (referrer) {
         const comm = Number((transaction.amount * 0.04).toFixed(2));
         referrer.walletBalance = Number((referrer.walletBalance + comm).toFixed(2));
         referrer.referralEarnings = Number(((referrer.referralEarnings || 0) + comm).toFixed(2));
         await referrer.save();
         await syncUserStocks(User, Stock, referrer._id, referrer.walletBalance, config);
         if (req.io) req.io.emit('userStatusChanged', { userId: referrer._id, walletBalance: referrer.walletBalance });
      }
    }
    
    transaction.status = 'success';
    await user.save();
    
    // Neural Sync: Activate/Rebuild Virtual Units
    await syncUserStocks(User, Stock, user._id, user.walletBalance, config);
    
    const listing = transaction.listingId;
    listing.quantity -= 1;
    if (listing.quantity <= 0) listing.status = 'SOLD';
    await listing.save();

    res.status(200).json({
      message: 'Payment Verified Automatically! Wallet Credited.',
      ocrData,
      status: 'success'
    });
  } else {
    transaction.status = verification.status || 'pending';
    res.status(200).json({
      message: verification.reason || 'Verification pending manual review.',
      ocrData,
      status: transaction.status
    });
  }

  await transaction.save();
};

module.exports = { createListing, getListings, claimListing, uploadReceipt };
