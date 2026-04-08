const admin = require('firebase-admin');

// Ensure that you set the FIREBASE_SERVICE_ACCOUNT_JSON environment variable 
// with the content of your service account key file as a JSON string.
try {
  if (!admin.apps.length) {
    const serviceAccountContent = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    
    if (serviceAccountContent) {
      const serviceAccount = JSON.parse(serviceAccountContent);
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
      });
    } else {
      console.warn('[NEURAL WARNING] Firebase Service Account JSON not found in environment. Social login verification will fail.');
    }
  }
} catch (error) {
  console.error('[NEURAL ERROR] Failed to initialize Firebase Admin:', error.message);
}

module.exports = admin;
