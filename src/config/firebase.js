const admin = require('firebase-admin');

// Ensure that you set the FIREBASE_SERVICE_ACCOUNT_JSON environment variable 
// with the content of your service account key file as a JSON string.
try {
  if (!admin.apps.length) {
    let serviceAccount;
    const serviceAccountContent = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    
    if (serviceAccountContent && serviceAccountContent.trim() !== "") {
      try {
        // Sanitize: Some environments escape newlines or add extra quotes
        let sanitizedContent = serviceAccountContent.trim();
        if (sanitizedContent.startsWith('"') && sanitizedContent.endsWith('"')) {
          sanitizedContent = sanitizedContent.substring(1, sanitizedContent.length - 1);
        }
        // Handle escaped newlines that might be literal "\n" strings
        sanitizedContent = sanitizedContent.replace(/\\n/g, '\n');
        
        serviceAccount = JSON.parse(sanitizedContent);
      } catch (e) {
        console.warn('[NEURAL WARNING] Failed to parse FIREBASE_SERVICE_ACCOUNT_JSON env var. Technical Detail:', e.message);
      }
    }

    if (!serviceAccount) {
      const fs = require('fs');
      const path = require('path');
      const serviceAccountPath = path.join(__dirname, '../../service-account.json');
      if (fs.existsSync(serviceAccountPath)) {
        serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));
      }
    }

    if (serviceAccount) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: "https://hellopay-89da2-default-rtdb.firebaseio.com/"
      });
      console.log(`[NEURAL] Firebase Admin & Realtime DB Initialized for project: ${serviceAccount.project_id}`);
    } else {
      console.warn('[NEURAL WARNING] Firebase Service Account not found. Social login verification will fail.');
    }
  }
} catch (error) {
  console.error('[NEURAL ERROR] Failed to initialize Firebase Admin:', error.message);
}

module.exports = admin;
