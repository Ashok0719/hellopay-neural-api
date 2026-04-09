const FirebaseShim = require('../utils/FirebaseShim');
const Config = new FirebaseShim('configs');

// Add helper specifically for 'SYSTEM_CONFIG' key which is used everywhere
const originalFindOne = Config.findOne.bind(Config);
Config.findOne = async (filter) => {
  if (filter && filter.key === 'SYSTEM_CONFIG') {
    // Optimization for common lookup
    return originalFindOne({ key: 'SYSTEM_CONFIG' });
  }
  return originalFindOne(filter);
};

module.exports = Config;
