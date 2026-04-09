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
    
    // Logic to find Amount (e.g., ₹500 or 500.00)
    // This is a basic regex, can be improved based on common app layouts
    const amountMatch = text.match(/(?:RS|INR|₹)\s*(\d+(?:,\d+)*(?:\.\d{2})?)/i) || 
                       text.match(/\b\d{1,}\.\d{2}\b/);

    return {
      success: true,
      rawText: text,
      extractedUtr: utrMatch ? utrMatch[0] : null,
      extractedAmount: amountMatch ? parseFloat(amountMatch[1].replace(/,/g, '')) : null,
      isSuccessFound: text.includes('SUCCESS') || text.includes('PAID') || text.includes('COMPLETED')
    };
  } catch (err) {
    console.error('OCR Process Error:', err);
    return { success: false, error: err.message };
  }
};

module.exports = { performOcr };
