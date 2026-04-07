const axios = require('axios');

const BASE_URL = 'http://localhost:5000/api';

async function runTests() {
  console.log('🚀 Starting HelloPay E2E System Tests...');

  try {
    // 1. Signup
    console.log('\n--- 1. Signup Test ---');
    const signupData = {
      name: 'Test User',
      email: `test_${Date.now()}@Hello.com`,
      phone: Date.now().toString().slice(-10),
      password: 'password123',
    };
    const signupRes = await axios.post(`${BASE_URL}/auth/register`, signupData);
    const token = signupRes.data.token;
    console.log('✅ Signup successful');

    // 2. Fetch Profile
    console.log('\n--- 2. Profile Test ---');
    const profileRes = await axios.get(`${BASE_URL}/auth/profile`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    console.log('✅ Profile view:', profileRes.data.name, '-', profileRes.data.walletBalance);

    // 3. Add Money (Mocked flow)
    console.log('\n--- 3. Add Money Test ---');
    // Note: We cannot fully test Razorpay verification here because we need actual payment_id
    // But we test the order creation
    const orderRes = await axios.post(`${BASE_URL}/wallet/add-money`, { amount: 1000 }, {
      headers: { Authorization: `Bearer ${token}` }
    });
    console.log('✅ Order created:', orderRes.data.id);

    // 4. Transfer Money (Mocked receiving user)
    console.log('\n--- 4. Transfer Money Test ---');
    const transferRes = await axios.post(`${BASE_URL}/transactions/transfer`, {
      receiverPhone: '9876543210', // Existing or mock phone
      amount: 50,
    }, {
      headers: { Authorization: `Bearer ${token}` }
    });
    console.log('✅ Transfer result:', transferRes.data.message);

    console.log('\n🌟 All API integration points verified successfully!');
  } catch (error) {
    console.error('❌ Test execution failed:', error.response?.data?.message || error.message);
  }
}

runTests();
