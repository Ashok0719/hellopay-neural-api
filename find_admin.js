const mongoose = require('mongoose');
const User = require('./src/models/User');
require('dotenv').config();

const findAdmin = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('Connected to MongoDB');

        const admin = await User.findOne({ role: 'admin' });
        if (admin) {
            console.log('Admin User Found:');
            console.log('Phone:', admin.phone);
            console.log('PIN:', admin.pin);
        } else {
            console.log('No Admin User Found. Creating default admin...');
            const newAdmin = await User.create({
                name: 'Neural Admin',
                phone: '9999999999',
                pin: '1234',
                role: 'admin',
                isOtpVerified: true
            });
            console.log('Default Admin Created:');
            console.log('Phone:', newAdmin.phone);
            console.log('PIN:', newAdmin.pin);
        }
        mongoose.connection.close();
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
};

findAdmin();
