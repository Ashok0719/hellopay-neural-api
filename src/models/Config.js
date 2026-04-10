const FirebaseShim = require('../utils/FirebaseShim');
const Config = new FirebaseShim('configs');

// Add helper specifically for 'SYSTEM_CONFIG' key which is used everywhere
const originalFindOne = Config.findOne.bind(Config);
let cachedConfig = null;
let lastFetch = 0;

Config.findOne = async (filter) => {
  if (filter && filter.key === 'SYSTEM_CONFIG') {
    // 60-second in-memory cache
    if (cachedConfig && (Date.now() - lastFetch < 60000)) {
       return cachedConfig;
    }
    
    cachedConfig = await originalFindOne({ key: 'SYSTEM_CONFIG' });
    lastFetch = Date.now();
    return cachedConfig;
  }
  return originalFindOne(filter);
};

module.exports = Config;
