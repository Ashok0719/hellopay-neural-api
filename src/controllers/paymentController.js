const Razorpay = require('razorpay');
const crypto = require('crypto');
const Transaction = require('../models/Transaction');
const StockTransaction = require('../models/StockTransaction');
const User = require('../models/User');
const Config = require('../models/Config');
const WalletLog = require('../models/WalletLog');
const { calculateFinancials, syncUserStocks, executeWalletRecharge, executeStockRotation } = require('../utils/financeLogic');
const { performOcr } = require('../utils/ocr');
const { auditUserBehavior } = require('../utils/fraudEngine');

// Initialize Razorpay Safely
let razorpay = null;
if (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) {
  razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
  });
} else {
  console.log('[NEURAL] Warning: Razorpay Credentials missing. Autonomous gateway disabled.');
}

/**
 * @desc    Create Razorpay Order (Wallet or Stock)
 * @route   POST /api/payments/create-order
 * @access  Private
 */
const createRazorpayOrder = async (req, res) => {
  try {
    const { amount, stockId } = req.body;
    const user = req.user;
    let targetAmount = amount;
    let description = `Wallet Recharge - ₹${amount}`;
    let type = 'add_money';

    // If stock purchase, fetch stock amount
    if (stockId) {
      const Stock = require('../models/Stock');
      const stock = await Stock.findById(stockId);
      if (!stock || stock.status !== 'AVAILABLE') {
        return res.status(404).json({ success: false, message: 'Neural Asset Node not available' });
      }
      targetAmount = stock.amount;
      description = `Stock Purchase - ₹${targetAmount} (Node: ${stockId})`;
      type = 'buy_stock';
    }

    if (!targetAmount || isNaN(targetAmount) || targetAmount <= 0) {
      return res.status(400).json({ success: false, message: 'Invalid amount' });
    }

    const config = await Config.findOne({ key: 'SYSTEM_CONFIG' });
    if (config && !config.depositEnabled) {
      return res.status(403).json({ success: false, message: 'Deposits are currently disabled' });
    }

    const options = {
      amount: Math.round(targetAmount * 100), // convert to paise
      currency: 'INR',
      receipt: `rcpt_${user._id.toString().slice(-6)}_${Date.now()}`,
      notes: {
        userId: user._id.toString(),
        type: type,
        stockId: stockId || ''
      }
    };

    if (!razorpay) {
      return res.status(503).json({ success: false, message: 'Autonomous Payment Node offline. Please use Manual Verification.' });
    }
    const order = await razorpay.orders.create(options);

    // Create a trace in Transaction ledger
    await Transaction.create({
      senderId: user._id,
      receiverId: user._id,
      type: type,
      amount: parseFloat(targetAmount),
      status: 'PENDING',
      razorpayOrderId: order.id,
      description: description
    });

    res.status(200).json({
      success: true,
      order_id: order.id,
      amount: order.amount,
      currency: order.currency,
      key_id: process.env.RAZORPAY_KEY_ID,
      transactionId: order.receipt, // For compatibility with frontend
      user: {
        name: user.name,
        email: user.email,
        phone: user.phone
      }
    });
  } catch (error) {
    console.error('[RAZORPAY] Create Order Error:', error);
    res.status(500).json({ success: false, message: 'Could not create payment order' });
  }
};

/**
 * @desc    Create Razorpay Order for Stock Purchase
 */
const createStockOrder = async (req, res) => {
  try {
    const { stockId } = req.body;
    const buyer = await User.findById(req.user._id);
    const Stock = require('../models/Stock');

    if (buyer.isBlocked) {
      return res.status(403).json({ success: false, message: 'Account locked' });
    }

    const stock = await Stock.findOne({ _id: stockId, status: 'AVAILABLE' })
      .populate('ownerId', 'name upiId qrCode');
    
    if (!stock) return res.status(400).json({ success: false, message: 'Stock not available' });

    if (stock.ownerId._id.toString() === buyer._id.toString()) {
      return res.status(400).json({ success: false, message: 'Self-purchase forbidden' });
    }

    if (!razorpay) {
      return res.status(503).json({ success: false, message: 'Autonomous Payment Node offline. Please use Manual Verification.' });
    }
    const rzpOrder = await razorpay.orders.create({
      amount: stock.amount * 100, // amount in paise
      currency: "INR",
      receipt: 'order_rcptid_' + Date.now()
    });

    // Create a transaction record linked to this Razorpay Order
    await StockTransaction.create({
       transactionId: 'TXN' + Date.now() + Math.floor(Math.random() * 1000),
       stockId: stock._id,
       buyerId: buyer._id,
       sellerId: stock.ownerId._id,
       amount: stock.amount,
       razorpayOrderId: rzpOrder.id,
       status: 'PENDING_PAYMENT'
    });

    // Lock the stock temporarily (LOCKED state)
    stock.status = 'LOCKED';
    stock.selectionExpires = new Date(Date.now() + 20 * 60 * 1000); // 20 min lock
    await stock.save();

    res.json({
      success: true,
      order: rzpOrder,
      transactionId: rzpOrder.id,
      amount: stock.amount,
      key: process.env.RAZORPAY_KEY_ID,
      buyerName: buyer.name,
      buyerEmail: buyer.email || `${buyer.userIdNumber}@hellopay.io`
    });
  } catch (err) {
    console.error('[RAZORPAY] Create Stock Order Error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * @desc    Verify Razorpay Payment Signature
 * @route   POST /api/payments/verify-payment
 * @access  Private
 */
const verifyPayment = async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ success: false, message: 'Missing payment signature details' });
    }

    const body = razorpay_order_id + "|" + razorpay_payment_id;
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(body.toString())
      .digest('hex');

    const isAuthentic = expectedSignature === razorpay_signature;

    if (!isAuthentic) {
      console.warn(`[RAZORPAY] Invalid Signature Attempt: Order ${razorpay_order_id}`);
      return res.status(400).json({ success: false, message: 'Payment verification failed: Signature mismatch' });
    }

    // signature is valid, but we wait for Webhook for actual credit to be safe (Rule 4)
    // However, we can update the transaction state to "WAITING_WEBHOOK" or similar
    const transaction = await Transaction.findOne({ razorpayOrderId: razorpay_order_id });
    if (transaction && transaction.status === 'PENDING') {
       transaction.razorpayPaymentId = razorpay_payment_id;
       await transaction.save();
    }

    res.status(200).json({ 
      success: true, 
      message: 'Signature verified. Awaiting network confirmation.',
      razorpay_payment_id 
    });
  } catch (error) {
    console.error('[RAZORPAY] Verification Error:', error);
    res.status(500).json({ success: false, message: 'Internal verification failure' });
  }
};

/**
 * @desc    Razorpay Webhook Handler (THE TRUTH)
 * @route   POST /api/payments/webhook
 * @access  Public (Signature Required)
 */
const handleWebhook = async (req, res) => {
  try {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    const signature = req.headers['x-razorpay-signature'];

    const shasum = crypto.createHmac('sha256', secret);
    shasum.update(JSON.stringify(req.body));
    const digest = shasum.digest('hex');

    if (signature !== digest) {
      console.error('[RAZORPAY WEBHOOK] Invalid Webhook Signature');
      return res.status(400).send('Invalid signature');
    }

    const { event, payload } = req.body;
    console.log(`[RAZORPAY WEBHOOK] Signal Received: ${event}`);

    if (event === 'payment.captured') {
      const payment = req.body.payload.payment.entity;
      const orderId = payment.order_id;
      const paymentId = payment.id;
      const amount = payment.amount / 100;
      const notes = payment.notes || {};

      // Idempotency: avoid double processing
      const transaction = await Transaction.findOne({ razorpayOrderId: orderId });
      
      if (!transaction) {
        console.error(`[RAZORPAY WEBHOOK] Transaction for order ${orderId} not found in database.`);
        return res.status(200).json({ status: 'Order not found' });
      }

      if (transaction.status === 'SUCCESS') {
        console.log(`[RAZORPAY WEBHOOK] Order ${orderId} already settled.`);
        return res.status(200).json({ status: 'Already processed' });
      }

      const user = await User.findById(transaction.senderId);
      if (!user) {
        console.error(`[RAZORPAY WEBHOOK] User ${transaction.senderId} not found.`);
        return res.status(200).json({ status: 'User not found' });
      }

      const config = await Config.findOne({ key: 'SYSTEM_CONFIG' });
      const { userParts, adminExtra, cashback } = calculateFinancials(amount, config);

      if (transaction.type === 'buy_stock' || notes.type === 'buy_stock') {
        // --- STOCK SETTLEMENT PROTOCOL ---
        const Stock = require('../models/Stock');
        const StockTransaction = require('../models/StockTransaction');
        
        const stock = await Stock.findOne({ 
          razorpayOrderId: orderId,
          status: 'LOCKED'
        });

        if (stock) {
          const seller = await User.findById(stock.ownerId);
          
          // 💰 Seller Liquidation
          if (seller) {
            seller.walletBalance = Math.max(0, seller.walletBalance - amount);
            await seller.save();
            await WalletLog.create({
              userId: seller._id,
              action: 'debit',
              amount: amount,
              balanceAfter: seller.walletBalance,
              description: `Autonomous Node Liquidation (ID: ${paymentId})`
            });
            await syncUserStocks(User, Stock, seller._id, seller.walletBalance, config);
          }

          // 💰 Buyer Credit
          user.walletBalance += amount;
          user.rewardBalance += (user.rewardBalance || 0) + cashback;
          user.totalDeposited += (user.totalDeposited || 0) + amount;
          await user.save();
          await WalletLog.create({
            userId: user._id,
            action: 'credit',
            amount: amount,
            balanceAfter: user.walletBalance,
            description: `Stock Acquisition Credit: ₹${amount}`
          });

          // ✅ Finalize Node Status
          stock.status = 'SOLD';
          stock.selectedBy = null;
          await stock.save();

          // Sync Buyer Nodes
          await syncUserStocks(User, Stock, user._id, user.walletBalance, config);

          // Update StockTransaction record if exists
          await StockTransaction.findOneAndUpdate(
            { razorpayOrderId: orderId },
            { status: 'SUCCESS', paymentId: paymentId }
          );
        } else {
           console.error(`[RAZORPAY WEBHOOK] Stock Node for order ${orderId} not found or not locked.`);
        }
      } else {
        // --- STANDARD WALLET SETTLEMENT ---
        user.walletBalance += amount;
        user.rewardBalance += (user.rewardBalance || 0) + cashback;
        user.totalDeposited += (user.totalDeposited || 0) + amount;
        await user.save();

        await WalletLog.create({
          userId: user._id,
          action: 'credit',
          amount: amount,
          balanceAfter: user.walletBalance,
          description: `Razorpay Neural Settlement: ₹${amount} (ID: ${paymentId})`,
        });

        // 🔁 Node Rebuilding (Multi-level rotation)
        const Stock = require('../models/Stock');
        await syncUserStocks(User, Stock, user._id, user.walletBalance, config);
      }

      // ✅ Finalize Transaction Ledger
      transaction.status = 'SUCCESS';
      transaction.razorpayPaymentId = paymentId;
      transaction.split = { adminExtra };
      transaction.cashback = cashback;
      await transaction.save();

      console.log(`[RAZORPAY WEBHOOK] Successfully settled ₹${amount} for ${user.email}`);
      
      if (req.io) {
        req.io.emit('stock_update', { action: 'refresh', userId: user._id });
        req.io.emit('payment_success', { orderId: orderId });
      }
    }
    res.status(200).send('OK');
  } catch (error) {
    console.error('[RAZORPAY WEBHOOK] Critical Error:', error);
    res.status(500).json({ status: 'error' });
  }
};

/**
 * @desc    Submit Manual Payment Proof (UTR + Screenshot)
 * @route   POST /api/payments/submit-proof
 * @access  Private
 */
const submitPaymentProof = async (req, res) => {
  try {
    const { amount, utr, paymentApp, stockId } = req.body;
    const userId = req.user._id;
    const file = req.file;

    if (!amount || !utr || !file) {
      return res.status(400).json({ success: false, message: 'Missing neural signals: amount, UTR, and proof required.' });
    }

    if (utr.length < 12 || utr.length > 22) {
      return res.status(400).json({ success: false, message: 'Invalid UTR format. Expected 12-22 characters.' });
    }

    // 1. UTR Duplicity Check
    const existingTx = await Transaction.findOne({ transactionId: utr });
    const existingStockTx = await StockTransaction.findOne({ utr: utr });
    if (existingTx || existingStockTx) {
      return res.status(400).json({ success: false, message: 'Security Alert: Transaction ID already processed.' });
    }

    // 2. Screenshot Hash Check (Fraud Prevention)
    const fs = require('fs');
    const fileBuffer = fs.readFileSync(file.path);
    const imageHash = crypto.createHash('md5').update(fileBuffer).digest('hex');
    
    const duplicateImage = await Transaction.findOne({ imageHash });
    if (duplicateImage) {
       return res.status(400).json({ success: false, message: 'Fraud Alert: Screenshot already utilized for another transaction.' });
    }

    // 3. Daily Limit Check
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const dailyCount = await Transaction.countDocuments({ 
      senderId: userId, 
      createdAt: { $gte: today },
      type: 'add_money'
    });
    if (dailyCount >= 5) {
      return res.status(403).json({ success: false, message: 'Daily submission limit exceeded. Try again tomorrow.' });
    }

    let sellerId = null;
    if (stockId) {
      const Stock = require('../models/Stock');
      const stock = await Stock.findById(stockId);
      if (stock) {
        sellerId = stock.ownerId;
      }
    }

    const screenshotUrl = `/uploads/${file.filename}`;
    
    // 4. Create Pending Transaction
    const transaction = await Transaction.create({
      senderId: userId,
      receiverId: sellerId || userId,
      sellerId: sellerId,
      stockId: stockId || null,
      type: stockId ? 'buy_stock' : 'add_money',
      amount: parseFloat(amount),
      status: 'PENDING',
      transactionId: utr,
      screenshotUrl,
      imageHash,
      description: `Manual Verification - ${paymentApp}`,
      deviceId: req.headers['x-device-id'] || 'WEB_CLIENT',
      ipAddress: req.headers['x-forwarded-for'] || req.connection.remoteAddress
    });

    // 5. OCR Auto-Verification (Optional/Hidden Confidence)
    const ocrResult = await performOcr(file.path);
    let autoVerified = false;

    if (ocrResult.success) {
      const amountDiff = Math.abs((ocrResult.extractedAmount || 0) - parseFloat(amount));
      const utrMatch = ocrResult.extractedUtr === utr;
      
      if (amountDiff < 2 && utrMatch && ocrResult.isSuccessFound) {
        // Log OCR confidence but wait for Admin Review for safety
        transaction.isOcrVerified = true;
      }
    }

    await transaction.save();

    // 6. Notify Admin (Socket.io Alarm)
    if (req.io) {
      req.io.emit('new_payment_submitted', {
        userId,
        amount,
        utr,
        screenshotUrl,
        transactionId: transaction._id
      });
    }

    res.status(200).json({
      success: true,
      message: 'Verification in progress. Your proof has been submitted to the Neural Node.',
      transactionId: transaction._id
    });

  } catch (err) {
    console.error('Submit Proof Error:', err);
    res.status(500).json({ success: false, message: 'Neural Submission Fault' });
  }
};

/** 
 * @desc    Admin: Approve Payment
 */
const approvePayment = async (req, res) => {
  try {
    const { id } = req.params;
    const config = await Config.findOne({ key: 'SYSTEM_CONFIG' });
    
    // Check both Transaction (Wallet) and StockTransaction (P2P)
    let transaction = await Transaction.findById(id);
    let isStockTx = false;

    if (!transaction) {
      transaction = await StockTransaction.findById(id);
      isStockTx = true;
    }

    if (!transaction || !['PENDING', 'PENDING_VERIFICATION', 'PENDING_PAYMENT', 'PENDING_REVIEW'].includes(transaction.status)) {
      return res.status(400).json({ success: false, message: 'Invalid transaction node or already processed' });
    }

    if (isStockTx) {
       // Manual P2P Rotation Settlement
       await executeStockRotation(transaction, req);
       transaction.status = 'SUCCESS';
       await transaction.save();
    } else {
       // Manual Wallet Recharge Settlement
       await executeWalletRecharge(transaction, config, req);
    }

    res.json({ success: true, message: 'Payment Approved and Settlement Executed' });

  } catch (err) {
    console.error('Approve Payment Error:', err);
    res.status(500).json({ success: false, message: 'Approval Protocol Failed: ' + err.message });
  }
};

const rejectPayment = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;
    
    let transaction = await Transaction.findById(id);
    let isStockTx = false;

    if (!transaction) {
      transaction = await StockTransaction.findById(id);
      isStockTx = true;
    }

    if (!transaction || !['PENDING', 'PENDING_VERIFICATION', 'PENDING_PAYMENT', 'PENDING_REVIEW'].includes(transaction.status)) {
      return res.status(400).json({ success: false, message: 'Invalid transaction node or already processed' });
    }

    transaction.status = 'FAILED';
    transaction.description = reason ? `Rejected: ${reason}` : 'Payment Rejected by Admin';
    await transaction.save();

    // Release stock node if this was a P2P rotation
    if (transaction.stockId) {
       const Stock = require('../models/Stock');
       const stock = await Stock.findById(transaction.stockId);
       if (stock) {
          stock.status = 'AVAILABLE';
          stock.selectedBy = null;
          stock.lockedUntil = null;
          stock.selectionExpires = null;
          await stock.save();
          if (req.io) req.io.emit('stock_update', { action: 'refresh' });
       }
    }

    if (req.io) {
      const targetUserId = isStockTx ? transaction.buyerId : transaction.senderId;
      req.io.emit('userStatusChanged', { 
        userId: targetUserId, 
        paymentStatus: 'FAILED',
        message: 'Payment Failed: Your proof was rejected by the admin.'
      });
    }

    if (req.io) {
      req.io.emit('payment_settled', { transactionId: id, status: 'FAILED', reason });
      req.io.emit('stock_update', { action: 'refresh' });
    }

    res.json({ success: true, message: 'Payment Rejected and Node Released' });

  } catch (err) {
    console.error('Reject Payment Error:', err);
    res.status(500).json({ success: false, message: 'Rejection Protocol Failed' });
  }
};

module.exports = {
  createRazorpayOrder,
  createStockOrder,
  verifyPayment,
  handleWebhook,
  submitPaymentProof,
  approvePayment,
  rejectPayment
};
