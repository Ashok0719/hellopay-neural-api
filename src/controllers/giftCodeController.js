const GiftCode = require('../models/GiftCode');
const User = require('../models/User');
const WalletLog = require('../models/WalletLog');
const crypto = require('crypto');

/**
 * @desc    Generate a random alphanumeric gift code (10 chars)
 */
const generateRandomCode = () => {
    return crypto.randomBytes(5).toString('hex').toUpperCase();
};

/**
 * @desc    Admin: Generate Gift Code
 */
exports.generateGiftCode = async (req, res) => {
    try {
        const { amount, usageLimit } = req.body;

        if (!amount || isNaN(amount) || amount <= 0) {
            return res.status(400).json({ success: false, message: 'Invalid amount parameter' });
        }

        const code = generateRandomCode();
        
        const giftCode = await GiftCode.create({
            code,
            amount,
            usageLimit: usageLimit || 1,
            createdBy: req.user?._id
        });

        res.json({ success: true, giftCode });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};

/**
 * @desc    Admin: Get all gift codes (history)
 */
exports.getGiftCodes = async (req, res) => {
    try {
        const giftCodes = await GiftCode.find()
            .sort({ createdAt: -1 })
            .populate('usedBy', 'name userIdNumber');
        res.json({ success: true, giftCodes });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};

/**
 * @desc    User: Claim Gift Code
 */
exports.claimGiftCode = async (req, res) => {
    try {
        const { code } = req.body;
        const userId = req.user._id;

        const giftCode = await GiftCode.findOne({ 
            code: code.trim().toUpperCase(),
            isActive: true 
        });

        if (!giftCode) {
            return res.status(404).json({ success: false, message: 'Invalid or deactivated gift code' });
        }

        // Check if already used by this user
        if (giftCode.usedBy.includes(userId)) {
            return res.status(400).json({ success: false, message: 'You have already claimed this signal code' });
        }

        // Check usage limit
        if (giftCode.timesUsed >= giftCode.usageLimit) {
            giftCode.isActive = false;
            await giftCode.save();
            return res.status(400).json({ success: false, message: 'Signal code reached maximum capacity' });
        }

        // Apply credit
        const user = await User.findById(userId);
        user.walletBalance += giftCode.amount;
        
        // Track usage
        giftCode.usedBy.push(userId);
        giftCode.timesUsed += 1;
        
        if (giftCode.timesUsed >= giftCode.usageLimit) {
            giftCode.isActive = false;
        }

        await Promise.all([user.save(), giftCode.save()]);

        // Log the transaction with correct neural context
        await WalletLog.create({
            userId,
            amount: giftCode.amount,
            action: 'gift_code',
            balanceAfter: user.walletBalance,
            description: `Signal Injected: Gift Code [${giftCode.code}]`
        });

        res.json({ 
            success: true, 
            message: `Neural Credit Success: ₹${giftCode.amount} added to your vault.`,
            walletBalance: user.walletBalance
        });

    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};

/**
 * @desc    Admin: Delete Gift Code
 */
exports.deleteGiftCode = async (req, res) => {
    try {
        await GiftCode.findByIdAndDelete(req.params.id);
        res.json({ success: true, message: 'Gift code purged' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};
