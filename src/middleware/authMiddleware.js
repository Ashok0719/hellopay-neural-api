const jwt = require('jsonwebtoken');
const User = require('../models/User');

const protect = async (req, res, next) => {
  let token;

  // Debugging: Log cookies to see if they are arriving
  if (process.env.NODE_ENV !== 'production') {
    console.log('[NEURAL AUTH] Received Cookies:', req.cookies);
  }

  // 1. Check Cookies (Primary for Web PWA)
  if (req.cookies && req.cookies.token) {
    token = req.cookies.token;
  } 
  // 2. Check Authorization Header (Backup for Mobile/Mobile-App)
  else if (
    req.headers.authorization &&
    req.headers.authorization.startsWith('Bearer')
  ) {
    token = req.headers.authorization.split(' ')[1];
  }

  if (token) {
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret123');
      req.user = await User.findById(decoded.id);

      if (!req.user) {
        return res.status(401).json({ message: 'Not authorized, user not found' });
      }

      return next();
    } catch (error) {
      console.error('[NEURAL AUTH ERROR] Token failed:', error.message);
      return res.status(401).json({ message: 'Not authorized, token failed' });
    }
  }

  if (!token) {
    return res.status(401).json({ message: 'Not authorized, no token' });
  }
};

const admin = (req, res, next) => {
  if (req.user && req.user.role === 'admin') { // Admin role check
    next();
  } else {
    res.status(401);
    throw new Error('Not authorized as an admin');
  }
};

module.exports = { protect, admin };
