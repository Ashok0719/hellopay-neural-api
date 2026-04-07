const mongoose = require('mongoose');

const listingSchema = new mongoose.Schema({
  stockName: { type: String, required: true },
  price: { type: Number, required: true },
  quantity: { type: Number, required: true },
  sellerUpiId: { type: String, required: true },
  qrCodeImage: { type: String }, // URL/Path to QR image
  sellerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  status: { 
    type: String, 
    enum: ['ACTIVE', 'SOLD', 'DISABLED'], 
    default: 'ACTIVE' 
  },
}, { timestamps: true });

const Listing = mongoose.model('Listing', listingSchema);
module.exports = Listing;
