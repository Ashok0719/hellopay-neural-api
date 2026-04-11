const https = require("https");
const PaytmChecksum = require("paytmchecksum");
const mongoose = require("mongoose");

const PaytmOrder = require("../models/PaytmOrder");
const User = require("../models/User");
const Transaction = require("../models/Transaction");

// ==============================
// 🔹 1. INITIATE TRANSACTION
// ==============================
exports.initiateTransaction = async (req, res) => {
  try {
    const { amount } = req.body;
    const userId = req.user._id;

    if (!amount || amount <= 0) {
      return res.status(400).json({ msg: "Invalid amount" });
    }

    const orderId = "ORD_" + Date.now();

    const paytmParams = {
      body: {
        requestType: "Payment",
        mid: process.env.PAYTM_MID,
        websiteName: process.env.PAYTM_WEBSITE || "WEBSTAGING",
        orderId,
        callbackUrl: process.env.PAYTM_CALLBACK_URL,
        txnAmount: {
          value: amount.toString(),
          currency: "INR",
        },
        userInfo: {
          custId: userId.toString(),
        },
      },
    };

    const checksum = await PaytmChecksum.generateSignature(
       JSON.stringify(paytmParams.body),
       process.env.PAYTM_MERCHANT_KEY
    );

    paytmParams.head = {
       signature: checksum,
    };

    const postData = JSON.stringify(paytmParams);

    const options = {
      hostname:
        process.env.PAYTM_ENVIRONMENT === "PRODUCTION"
          ? "securegw.paytm.in"
          : "securegw-stage.paytm.in",
      port: 443,
      path: "/theia/api/v1/initiateTransaction?mid=" + process.env.PAYTM_MID + "&orderId=" + orderId,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": postData.length,
      },
    };

    const paytmRes = await new Promise((resolve, reject) => {
      const reqPaytm = https.request(options, (response) => {
        let data = "";
        response.on("data", (chunk) => (data += chunk));
        response.on("end", () => resolve(JSON.parse(data)));
      });

      reqPaytm.on("error", reject);
      reqPaytm.write(postData);
      reqPaytm.end();
    });

    if (!paytmRes.body || !paytmRes.body.txnToken) {
        return res.status(500).json({ msg: "Initiation failed", error: paytmRes });
    }

    const txnToken = paytmRes.body.txnToken;

    // Save order
    await PaytmOrder.create({
      orderId,
      userId,
      amount,
      txnToken,
      status: "PENDING",
    });

    res.json({
      orderId,
      txnToken,
      amount,
      mid: process.env.PAYTM_MID
    });
  } catch (err) {
    console.error('Paytm Initiate Error:', err);
    res.status(500).json({ msg: "Initiation failed" });
  }
};

// ==============================
// 🔹 2. VERIFY FROM PAYTM SERVER
// ==============================
const verifyWithPaytm = async (orderId) => {
  const paytmParams = {
    MID: process.env.PAYTM_MID,
    ORDERID: orderId,
  };

  const checksum = await PaytmChecksum.generateSignature(
    JSON.stringify(paytmParams),
    process.env.PAYTM_MERCHANT_KEY
  );

  const postData = JSON.stringify({
    body: paytmParams,
    head: { signature: checksum },
  });

  const options = {
    hostname:
      process.env.PAYTM_ENVIRONMENT === "PRODUCTION"
        ? "securegw.paytm.in"
        : "securegw-stage.paytm.in",
    port: 443,
    path: "/v3/order/status",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": postData.length,
    },
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve(JSON.parse(data)));
    });

    req.on("error", reject);
    req.write(postData);
    req.end();
  });
};

// ==============================
// 🔹 3. PROCESS PAYMENT (COMMON)
// ==============================
const processSuccessfulPayment = async (orderId, txnId, io) => {
  const order = await PaytmOrder.findOne({ orderId });

  if (!order) return;

  // 🚫 Idempotency check
  if (order.status === "SUCCESS") return;

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    // Atomic update to user balance
    await User.updateOne(
      { _id: order.userId },
      { $inc: { walletBalance: order.amount } },
      { session }
    );

    // Create a formal transaction record compatible with existing schema
    await Transaction.create(
      [
        {
          senderId: null,
          receiverId: order.userId,
          amount: order.amount,
          type: "add_money",
          status: "SUCCESS",
          transactionId: txnId,
          referenceId: orderId,
          description: "Refill via Paytm"
        },
      ],
      { session }
    );

    order.status = "SUCCESS";
    order.txnId = txnId;
    await order.save({ session });

    await session.commitTransaction();
    
    // Notify via Socket
    if (io) {
        io.emit('userStatusChanged', { 
            userId: order.userId, 
            message: `₹${order.amount} credited via Paytm` 
        });
    }
    
  } catch (err) {
    await session.abortTransaction();
    console.error('Process Success Payment Error:', err);
  } finally {
    session.endSession();
  }
};

// ==============================
// 🔹 4. CALLBACK HANDLER
// ==============================
exports.callback = async (req, res) => {
  try {
    const paytmParams = req.body;

    const isValidChecksum = PaytmChecksum.verifySignature(
      paytmParams,
      process.env.PAYTM_MERCHANT_KEY,
      paytmParams.CHECKSUMHASH
    );

    if (!isValidChecksum) {
      return res.status(400).send("Checksum mismatch");
    }

    const { ORDERID } = paytmParams;

    const result = await verifyWithPaytm(ORDERID);

    if (result.body && result.body.resultInfo && result.body.resultInfo.resultStatus === "TXN_SUCCESS") {
      await processSuccessfulPayment(
        ORDERID,
        result.body.txnId,
        req.io
      );

      return res.redirect(
        `${process.env.FRONTEND_URL || 'http://localhost:3000'}/wallet?status=SUCCESS`
      );
    } else {
      return res.redirect(
        `${process.env.FRONTEND_URL || 'http://localhost:3000'}/wallet?status=FAILED`
      );
    }
  } catch (err) {
    console.error('Paytm Callback Error:', err);
    res.status(500).send("Callback error");
  }
};

// ==============================
// 🔹 5. WEBHOOK HANDLER (BACKUP)
// ==============================
exports.webhook = async (req, res) => {
  try {
    const { ORDERID } = req.body;

    const result = await verifyWithPaytm(ORDERID);

    if (result.body && result.body.resultInfo && result.body.resultInfo.resultStatus === "TXN_SUCCESS") {
      await processSuccessfulPayment(
        ORDERID,
        result.body.txnId,
        req.io
      );
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('Paytm Webhook Error:', err);
    res.sendStatus(500);
  }
};

// ==============================
// 🔹 6. VERIFY API (FRONTEND POLLING)
// ==============================
exports.verifyPayment = async (req, res) => {
  try {
    const { orderId } = req.query;

    const order = await PaytmOrder.findOne({ orderId });

    if (!order) {
      return res.status(404).json({ status: "NOT_FOUND" });
    }

    res.json({
      status: order.status,
      amount: order.amount,
    });
  } catch (err) {
    res.status(500).json({ msg: "Verification failed" });
  }
};
