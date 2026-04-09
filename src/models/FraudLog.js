const FirebaseShim = require('../utils/FirebaseShim');
const FraudLog = new FirebaseShim('fraudlogs');

module.exports = FraudLog;
