const jwt = require('jsonwebtoken');
const User = require('../models/User');

const protect = async (req, res, next) => {
  const token = req.cookies.token || (req.headers.authorization?.startsWith('Bearer') ? req.headers.authorization.split(' ')[1] : null);

  if (!token) {
    return res.status(401).json({ message: "No token" });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret123');
    req.user = await User.findById(decoded.id);
    if (!req.user) {
      res.clearCookie('token'); // Kill the ghost session
      return res.status(401).json({ message: "Identity node missing - Access reset" });
    }
    next();
  } catch (err) {
    return res.status(401).json({ message: "Invalid token" });
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
