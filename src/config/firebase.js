const admin = require('firebase-admin');

// Ensure that you set the FIREBASE_SERVICE_ACCOUNT_JSON environment variable 
// with the content of your service account key file as a JSON string.
try {
  if (!admin.apps.length) {
    let serviceAccount;
    const serviceAccountContent = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    
    // Strategy A: Check for Render Secret File (Most Reliable)
    const fs = require('fs');
    const path = require('path');
    const secretPath = '/etc/secrets/firebase-key.json'; // Official Render mount point
    const rootSecretPath = path.join(process.cwd(), 'firebase-key.json');
    const altSecretPath = path.join(__dirname, '../../firebase-key.json');

    if (fs.existsSync(secretPath)) {
      try {
        serviceAccount = JSON.parse(fs.readFileSync(secretPath, 'utf8'));
        console.log('[NEURAL] Firebase Key loaded from /etc/secrets/firebase-key.json');
      } catch (e) {
        console.warn('[NEURAL WARNING] Failed to parse /etc/secrets JSON:', e.message);
      }
    } else if (fs.existsSync(rootSecretPath)) {
      try {
        serviceAccount = JSON.parse(fs.readFileSync(rootSecretPath, 'utf8'));
        console.log('[NEURAL] Firebase Key loaded from root/firebase-key.json');
      } catch (e) {
        console.warn('[NEURAL WARNING] Failed to parse root JSON:', e.message);
      }
    } else if (fs.existsSync(altSecretPath)) {
      try {
        serviceAccount = JSON.parse(fs.readFileSync(altSecretPath, 'utf8'));
        console.log('[NEURAL] Firebase Key loaded from local/alt secret file.');
      } catch (e) {
        console.warn('[NEURAL WARNING] Failed to parse Alt Secret File JSON:', e.message);
      }
    }

    // Strategy B: Fallback to Environment Variable with Deep Sanitization
    if (!serviceAccount && serviceAccountContent && serviceAccountContent.trim() !== "") {
      try {
        let sanitizedContent = serviceAccountContent.trim();
        if (sanitizedContent.startsWith('"') && sanitizedContent.endsWith('"')) {
          sanitizedContent = sanitizedContent.substring(1, sanitizedContent.length - 1);
        }
        sanitizedContent = sanitizedContent.replace(/\r?\n/g, '\\n');
        sanitizedContent = sanitizedContent.replace(/[\x00-\x1F\x7F-\x9F]/g, (match) => {
          if (match === '\n') return '\\n';
          if (match === '\r') return '';
          return ''; 
        });
        serviceAccount = JSON.parse(sanitizedContent);
      } catch (e) {
        console.warn('[NEURAL WARNING] Env var parse failed. Falling back to Strategy C.');
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
