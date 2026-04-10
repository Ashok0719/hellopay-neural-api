const admin = require('./src/config/firebase');

async function testInit() {
  console.log('--- Firebase Initialization Test ---');
  try {
    if (admin.apps.length) {
      console.log('✅ Firebase Admin Initialized successfully.');
      console.log('Project ID:', admin.app().options.credential.projectId || 'Unknown (Check cert)');
      
      // Try listing users or something simple
      const listUsers = await admin.auth().listUsers(1);
      console.log('✅ Auth service is operational.');
    } else {
      console.log('❌ Firebase Admin NOT initialized.');
    }
  } catch (error) {
    console.error('❌ Firebase Test Failed:', error.message);
  }
  process.exit();
}

testInit();
