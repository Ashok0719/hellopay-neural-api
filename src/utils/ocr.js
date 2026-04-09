const Tesseract = require('tesseract.js');

/**
 * Feature 3: Advanced Screenshot OCR Utility
 * Extracts amount and UTR from payment screenshots
 */
const performOcr = async (filePath) => {
  try {
    const result = await Tesseract.recognize(filePath, 'eng');
    const text = result.data.text.toUpperCase();

    // Logic to find UTR (12-22 digits)
    const utrMatch = text.match(/\b\d{12,22}\b/);
    
    // Logic to find Amount (Improved for GPay/PhonePe layouts)
    const amountMatch = text.match(/(?:RS|INR|₹|TOTAL|AMOUNT)\s*[:=]?\s*(\d+(?:,\d+)*(?:\.\d{2})?)/i) || 
                       text.match(/\b\d{1,6}(?:\.\d{2})\b/);

    // Logic to find Receiver UPI (username@handle)
    const upiMatch = text.match(/[a-z0-9._-]{3,}@[a-z]{2,}/i);

    let extractedAmount = null;
    if (amountMatch) {
      const val = amountMatch[1] || amountMatch[0];
      extractedAmount = parseFloat(val.replace(/[^\d.]/g, ''));
    }

    return {
      success: true,
      rawText: text,
      extractedUtr: utrMatch ? utrMatch[0] : null,
      extractedAmount,
      extractedReceiver: upiMatch ? upiMatch[0].toLowerCase() : null,
      isSuccessFound: /SUCCESS|PAID|COMPLETED|DONE|SENT|TRANSFERRED/i.test(text)
    };
  } catch (err) {
    console.error('OCR Process Error:', err);
    return { success: false, error: err.message };
  }
};

module.exports = { performOcr };
