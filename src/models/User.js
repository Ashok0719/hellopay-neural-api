const FirebaseShim = require('../utils/FirebaseShim');
const bcrypt = require('bcryptjs');

const UserShim = new FirebaseShim('users');

const User = {
  ...UserShim,
  
  async create(data) {
    const payload = { ...data };
    
    // Mimic pre-save logic
    if (!payload.userIdNumber) {
      payload.userIdNumber = Math.floor(100000 + Math.random() * 900000);
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
  },

  async findByIdAndUpdate(id, update, options = {}) {
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
  },

  // Helper methods that was on the instance
  async matchPassword(user, enteredPassword) {
    if (!user || !user.password) return false;
    return await bcrypt.compare(enteredPassword, user.password);
  },

  async matchPin(user, enteredPin) {
    if (!user || !user.pin) return false;
    return await bcrypt.compare(enteredPin, user.pin);
  }
};

module.exports = User;
