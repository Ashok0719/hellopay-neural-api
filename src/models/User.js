const FirebaseShim = require('../utils/FirebaseShim');
const bcrypt = require('bcryptjs');

const UserShim = new FirebaseShim('users');

const User = UserShim; // Base all standard methods on the Shim

// Add custom overrides and extensions
User.create = async function(data) {
  const payload = { ...data };
  
  if (!payload.userIdNumber) {
    payload.userIdNumber = Math.floor(100000 + Math.random() * 900000).toString();
  }
  if (!payload.referralCode) {
    payload.referralCode = Math.random().toString(36).substring(2, 7).toUpperCase();
  }
  if (payload.password) {
    const salt = await bcrypt.genSalt(10);
    payload.password = await bcrypt.hash(payload.password, salt);
  }
  if (payload.pin) {
    const salt = await bcrypt.genSalt(10);
    payload.pin = await bcrypt.hash(payload.pin, salt);
  }
  
  return UserShim.create(payload);
};

User.findByIdAndUpdate = async function(id, update, options = {}) {
  const payload = { ...update };
  
  if (payload.password) {
    const salt = await bcrypt.genSalt(10);
    payload.password = await bcrypt.hash(payload.password, salt);
  }
  if (payload.pin) {
    const salt = await bcrypt.genSalt(10);
    payload.pin = await bcrypt.hash(payload.pin, salt);
  }
  
  return UserShim.findByIdAndUpdate(id, payload, options);
};

// Helper methods
User.matchPassword = async function(user, enteredPassword) {
  if (!user || !user.password) return false;
  return await bcrypt.compare(enteredPassword, user.password);
};

User.matchPin = async function(user, enteredPin) {
  if (!user || !user.pin || !enteredPin) return false;
  // Handle plaintext PINs if needed, or just bcrypt
  if (enteredPin === user.pin) return true;
  return await bcrypt.compare(enteredPin, user.pin);
};

module.exports = User;
