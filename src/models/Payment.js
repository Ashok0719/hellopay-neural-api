const FirebaseShim = require('../utils/FirebaseShim');
const Payment = new FirebaseShim('payments');

module.exports = Payment;
