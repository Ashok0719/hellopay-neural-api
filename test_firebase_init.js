const dotenv = require('dotenv');
const path = require('path');
dotenv.config();

const admin = require('./src/config/firebase');

console.log('Firebase Apps length:', admin.apps.length);
if (admin.apps.length > 0) {
  console.log('Firebase initialized successfully.');
} else {
  console.log('Firebase not initialized.');
}
