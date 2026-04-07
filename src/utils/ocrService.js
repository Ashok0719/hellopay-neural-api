const Tesseract = require('tesseract.js');

/**
 * Extracts transaction details from a payment screenshot using OCR.
 * @param {string} imagePath - Path to the screenshot.
 * @returns {Promise<{amount: number, transactionId: string, utr: string, receiverUpi: string}>}
 */
const extractTransactionDetails = async (imagePath) => {
  try {
    const { data: { text } } = await Tesseract.recognize(imagePath, 'eng', {
      logger: m => console.log(`[OCR] ${m.progress * 100}%`)
    });

    console.log('[OCR] Raw Text Extracted:', text);

    // Regex patterns for Indian UPI (Common formats: GPay, PhonePe, Paytm)
    const amountRegex = /(?:Amount|Paid|Rs\.?|₹)\s*([\d,]+\.?\d*)/i;
    const txnIdRegex = /(?:Transaction ID|Txn ID|ID)\s*[:\-]?\s*([A-Z0-9]+)/i;
    const utrRegex = /(?:UTR|Ref No)\s*[:\-]?\s*(\d{12})/i;
    const upiRegex = /[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z]{2,64}/;

    const amountMatch = text.match(amountRegex);
    const txnIdMatch = text.match(txnIdRegex);
    const utrMatch = text.match(utrRegex);
    const upiMatch = text.match(upiRegex);

    return {
      amount: amountMatch ? parseFloat(amountMatch[1].replace(/,/g, '')) : null,
      transactionId: txnIdMatch ? txnIdMatch[1] : (utrMatch ? utrMatch[1] : null),
      receiverUpi: upiMatch ? upiMatch[0] : null,
      rawText: text
    };
  } catch (error) {
    console.error('[OCR] Extraction Error:', error);
    return null;
  }
};

/**
 * Verifies if the OCR data matches the stored order/listing data.
 */
const verifyPaymentData = (ocrData, orderData) => {
  if (!ocrData || !orderData) return { success: false, reason: 'Missing data' };

  const amountMatch = Math.abs(ocrData.amount - orderData.amount) < 1; // Allow small float variance
  const upiMatch = ocrData.receiverUpi?.toLowerCase() === orderData.sellerUpiId?.toLowerCase();

  if (amountMatch && upiMatch) {
    return { success: true, status: 'success' };
  } else if (!amountMatch) {
    return { success: false, status: 'rejected', reason: 'Amount mismatch' };
  } else {
    return { success: false, status: 'pending', reason: 'Partial match / High uncertainty' };
  }
};

module.exports = { extractTransactionDetails, verifyPaymentData };
