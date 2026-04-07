const StockTransaction = require('../models/StockTransaction');
const User = require('../models/User');
const Stock = require('../models/Stock');

/**
 * HelloPay Neural Support AI (Automated Rotation Analyst)
 * Handles 24/7 intelligent ticket resolution.
 */
exports.handleChatRequest = async (req, res) => {
  try {
    const { message } = req.body;
    const user = req.user;
    const input = message.toLowerCase();

    let response = "";
    let action = null;

    // ── 1. GREETINGS & CASUAL INPUT ───────────────────────────
    if (input.includes('hi') || input.includes('hello') || input.includes('hey')) {
      response = `Neural Support Online. Hello ${user.name.split(' ')[0]}! How can I assist with your asset rotation today?`;
    }

    // ── 2. PAYMENT & UTR INQUIRIES ────────────────────────────
    else if (input.includes('i paid') || input.includes('amount') || input.includes('payment') || input.includes('money')) {
      // Check for 12-digit UTR in input
      const utrMatch = input.match(/\b\d{12}\b/);
      if (utrMatch) {
        const utr = utrMatch[0];
        const existingTx = await StockTransaction.findOne({ utr }).populate('buyerId', 'name').populate('sellerId', 'name');

        if (existingTx) {
          if (existingTx.status === 'SUCCESS') {
            response = `Node Identity Verified. UTR ${utr} has been successfully settled for ₹${existingTx.amount}. Your wallet has been credited.`;
          } else if (existingTx.status === 'PENDING_REVIEW') {
            response = `Signal Discrepancy Found. UTR ${utr} for ₹${existingTx.amount} is currently under Manual Audit. Please wait as an admin verifies the proof.`;
          } else if (existingTx.status === 'TIMEOUT') {
             response = `TIMEOUT FAULT: UTR ${utr} was submitted beyond the 20-minute window. As per protocol, the assets have been revoked by the administration.`;
          } else {
            response = `UTR ${utr} is currently in state: ${existingTx.status}. Our neural engine is still processing the rotation.`;
          }
        } else {
          // Check for fraud: Is this user spamming random UTRs?
          response = `Protocol Check: UTR ${utr} not found in our neural ledger. Please ensure you have uploaded the screenshot in the checkout terminal for verification.`;
        }
      } else {
        response = `To check your payment status instantly, please provide the 12-digit UTR number from your payment app (GPay/PhonePe/Paytm).`;
      }
    }

    // ── 3. STOCK & MARKETPLACE ISSUES ─────────────────────────
    else if (input.includes('stock') || input.includes('split') || input.includes('visible')) {
      const activeSplits = await Stock.countDocuments({ ownerId: user._id, status: 'AVAILABLE' });
      if (activeSplits > 0) {
        response = `Neural Snapshot: You have ${activeSplits} active split units currently listed in the marketplace. They are visible to all other buyers.`;
      } else {
        response = `Marketplace Protocol: No active splits found for your node. You can click "Deposit" to convert your wallet balance into sellable stock.`;
      }
    }

    // ── 4. UPI & APP ISSUES ───────────────────────────────────
    else if (input.includes('upi') || input.includes('not opening') || input.includes('app')) {
      response = `UPI Protocol Guide: If apps are not opening, use the "Copy UPI ID" feature in the checkout terminal and manually pay via your preferred bank app. Afterward, paste the UTR to verify.`;
    }

    // ── 5. WALLET & BALANCE ───────────────────────────────────
    else if (input.includes('balance') || input.includes('wallet') || input.includes('paisa')) {
      response = `Wallet Audit: Your current neural balance is ₹${user.walletBalance.toLocaleString()}. Earnings from node rotations are settled atomically upon verification.`;
    }

    // ── 6. CATCH-ALL / ESCALATION ─────────────────────────────
    else {
      response = "I'm the HelloPay AI. I can help with UTR verification, Stock visibility, and Wallet sync. Could you be more specific about the issue?";
    }

    // SIMULATED LATENCY (For "Human-like" feel)
    res.json({ 
      success: true, 
      response, 
      sender: 'AI_SUPPORT', 
      timestamp: new Date() 
    });

  } catch (err) {
    console.error('[Support AI Error]:', err);
    res.status(500).json({ success: false, message: 'Support Node Disconnected' });
  }
};
