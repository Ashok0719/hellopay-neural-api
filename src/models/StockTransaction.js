const FirebaseShim = require('../utils/FirebaseShim');
const StockTransaction = new FirebaseShim('stocktransactions');

module.exports = StockTransaction;
