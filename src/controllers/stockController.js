const Stock = require('../models/Stock');
const StockTransaction = require('../models/StockTransaction');
const User = require('../models/User');
const Config = require('../models/Config');
const Tesseract = require('tesseract.js');
const crypto = require('crypto');
const axios = require('axios');
const fs = require('fs');
const Transaction = require('../models/Transaction');
const { auditUserBehavior } = require('../utils/fraudEngine');
const { findBestSplits, syncUserStocks } = require('../utils/financeLogic');
const { executeWalletRecharge } = require('./walletController');

// Fastring Integration Helper
const createFastringStockOrder = async (amount, userId, referenceId) => {
  const fastringOrderId = `FR_STOCK_${referenceId}_${Date.now().toString().slice(-4)}`;
  const paymentUrl = `${process.env.FASTRING_PAY_BASE_URL || 'https://fastring.app/pay'}?amount=${amount}&userId=${userId}&orderId=${referenceId}&fastId=${fastringOrderId}&type=STOCK&callback=${encodeURIComponent(process.env.FASTRING_CALLBACK_URL || 'https://api.hellopayapp.com/api/stocks/fastring-webhook')}`;

  return { 
     id: fastringOrderId, 
     payment_url: paymentUrl,
     success: true 
  };
};

const cleanUTR = (str) => {
  if (!str) return '';
  return str.toString().replace(/[^a-zA-Z0-9]/g, '').toUpperCase().trim();
};

const executeStockRotation = async (transaction, req) => {
    const config = await Config.findOne({ key: 'SYSTEM_CONFIG' });
    const buyer = await User.findById(transaction.buyerId);
    const seller = await User.findById(transaction.sellerId);
    
    const amount = Number(transaction.amount);
    
    // Financial Protocol: 4% Reward for Buyer
    const profit = Number((amount * 0.04).toFixed(2));
    buyer.walletBalance += (amount + profit);
    buyer.totalRewards += profit;
    await buyer.save();

    // Seller Protocol: Immediate Liquidation
    seller.walletBalance = Math.max(0, seller.walletBalance - amount);
    await seller.save();

    // Log the audit Trail
    await WalletLog.create({
        userId: buyer._id,
        action: 'credit',
        amount: amount + profit,
        balanceAfter: buyer.walletBalance,
        description: `P2P Rotation Completed: Node Purchase + 4% Profit.`
    });

    await syncUserStocks(User, Stock, buyer._id, buyer.walletBalance, config);
    await syncUserStocks(User, Stock, seller._id, seller.walletBalance, config);
};

exports.getStocks = async (req, res) => {
  try {
    const stocks = await Stock.find({ status: 'AVAILABLE' }).populate('ownerId', 'name upiId');
    res.json({ stocks });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.generateVirtualSplits = async (req, res) => {
  const { amount } = req.body;
  const splits = findBestSplits(amount);
  res.json({ splits });
};

exports.selectStock = async (req, res) => {
  try {
    const { stockId } = req.body;
    const stock = await Stock.findById(stockId);
    if (!stock || stock.status !== 'AVAILABLE') return res.status(400).json({ message: 'Node no longer available' });

    stock.status = 'LOCKED';
    stock.selectedBy = req.user._id;
    stock.selectionExpires = new Date(Date.now() + 20 * 60 * 1000); // 20 mins
    await stock.save();

    res.json({ success: true, message: 'Node locked for 20 minutes' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.cancelSelection = async (req, res) => {
  try {
    const { stockId } = req.body;
    const stock = await Stock.findById(stockId);
    if (stock && stock.selectedBy.toString() === req.user._id.toString()) {
      stock.status = 'AVAILABLE';
      stock.selectedBy = null;
      stock.selectionExpires = null;
      await stock.save();
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.buyStock = async (req, res) => {
  // Logic to create transaction record
  res.json({ success: true });
};

exports.createStockOrder = async (req, res) => {
  try {
    const { stockId } = req.body;
    
    // Neural Link: Retrieve the existing split unit registry
    const stock = await Stock.findById(stockId);
    if (!stock) {
       return res.status(404).json({ message: 'Neural Node Not Found: The split unit has expired or been claimed.' });
    }

    if (stock.status !== 'AVAILABLE') {
       return res.status(400).json({ message: 'Neural Node Unavailable: This fragment is currently locked for another transaction.' });
    }

    const amount = stock.amount;
    const sellerId = stock.ownerId;
    const transactionId = `HP_ROT_${Date.now()}_${Math.random().toString(36).slice(-4).toUpperCase()}`;

    const order = await createFastringStockOrder(amount, req.user._id, transactionId);
    
    // Create pending stock transaction record
    const transaction = await StockTransaction.create({
        transactionId: transactionId,
        buyerId: req.user._id,
        sellerId: sellerId,
        stockId: stockId,
        amount: amount,
        status: 'PENDING_PAYMENT',
        fastringOrderId: order.id
    });

    // Lock the stock node
    stock.status = 'LOCKED';
    stock.selectedBy = req.user._id;
    stock.selectionExpires = new Date(Date.now() + 20 * 60 * 1000); // 20 min lock
    await stock.save();
    
    res.json({ 
       success: true,
       orderId: order.id,
       paymentUrl: order.payment_url,
       amount: amount,
       transactionId: transaction._id,
       buyerName: req.user.name 
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.uploadPaymentScreenshot = async (req, res) => {
  res.json({ success: true, message: 'Neural Proof Submitted' });
};

exports.cancelStockTransaction = async (req, res) => {
  try {
    const { transactionId } = req.params;
    const transaction = await StockTransaction.findById(transactionId);
    if (transaction) {
        transaction.status = 'FAILED';
        await transaction.save();
        const stock = await Stock.findById(transaction.stockId);
        if (stock) {
            stock.status = 'AVAILABLE';
            await stock.save();
        }
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.getTransaction = async (req, res) => {
  const transaction = await StockTransaction.findById(req.params.id).populate('sellerId', 'name upiId qrCode');
  res.json({ success: true, transaction });
};

exports.handleFastringWebhook = async (req, res) => {
  const { fastring_order_id, status, amount } = req.body;
  const config = await Config.findOne({ key: 'SYSTEM_CONFIG' });

  // 1. Find Stock Rotation Transaction
  const transaction = await StockTransaction.findOne({ fastringOrderId: fastring_order_id, status: 'PENDING_PAYMENT' });
  
  if (status === 'SUCCESS' && transaction) {
    transaction.status = 'SUCCESS';
    await transaction.save();
    
    const stock = await Stock.findById(transaction.stockId);
    if (stock) {
        stock.status = 'SOLD';
        await stock.save();
    }

    // P2P Credit/Debit Logic
    const buyer = await User.findById(transaction.buyerId);
    const seller = await User.findById(transaction.sellerId);
    const rotateAmount = Number(amount || transaction.amount);
    
    buyer.walletBalance += rotateAmount;
    await buyer.save();
    
    seller.walletBalance = Math.max(0, seller.walletBalance - rotateAmount);
    await seller.save();
    
    await syncUserStocks(User, Stock, buyer._id, buyer.walletBalance, config);
    await syncUserStocks(User, Stock, seller._id, seller.walletBalance, config);
    
    if (req.io) req.io.emit('stock_update', { action: 'refresh' });
    return res.status(200).json({ status: 'ok' });
  }
  
  // 2. Or is it a Wallet Transaction?
  const walletTx = await Transaction.findOne({ fastringOrderId: fastring_order_id, status: 'PENDING' });
  if (status === 'SUCCESS' && walletTx) {
    await executeWalletRecharge(walletTx, config);
    return res.status(200).json({ status: 'ok' });
  }

  res.status(200).json({ status: 'ok' });
};
