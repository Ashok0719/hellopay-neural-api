console.log('[dotenv@17.3.1] injecting env (6) from .env -');

const dns = require('dns');
if (dns.setServers) {
  dns.setServers(['8.8.8.8', '8.8.4.4']);
}

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const morgan = require('morgan');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Server } = require('socket.io');
const cookieParser = require('cookie-parser');

const authRoutes = require('./routes/authRoutes');
const walletRoutes = require('./routes/walletRoutes');
const transactionRoutes = require('./routes/transactionRoutes');
const adminRoutes = require('./routes/adminRoutes');
const listingRoutes = require('./routes/listingRoutes');
const { errorHandler } = require('./middleware/errorMiddleware');
const connectDB = require('./config/db');
const dotenv = require('dotenv');

dotenv.config();
connectDB().then(async () => {
  const Config = require('./models/Config');
  const existingConfig = await Config.findOne({ key: 'SYSTEM_CONFIG' });
  if (!existingConfig) {
    console.log('Initializing Neural Base Configuration...');
    await Config.create({
      key: 'SYSTEM_CONFIG',
      stockPlans: [
        { amount: 1000, code: 'SIG1000', isActive: true },
        { amount: 5000, code: 'SIG5000', isActive: true }
      ],
      globalCashbackPercent: 4,
      profitPercentage: 4
    });
  }
});

const app = express();
const server = require('http').createServer(app);
const io = new Server(server, {
  cors: { 
    origin: (origin, callback) => {
      if (!origin || process.env.NODE_ENV !== 'production') return callback(null, true);
      const isAllowed = origin.includes('.vercel.app') || 
                        origin.includes('.loca.lt') || 
                        (process.env.ALLOWED_ORIGINS || '').split(',').includes(origin);
      if (isAllowed) return callback(null, true);
      callback(new Error('Neural CORS: Socket Node Unauthorized'), false);
    },
    methods: ["GET", "POST", "PUT"] 
  }
});

// HelloPay Neural Core Init
console.log('--- HelloPay Neural Base Initializing ---');
app.use(helmet({
  contentSecurityPolicy: false,
})); 
app.use(morgan('dev'));

const allowedOrigins = process.env.NODE_ENV === 'production'
  ? (process.env.ALLOWED_ORIGINS || '').split(',').map(o => o.trim())
  : ['http://localhost:3000', 'http://localhost:3001', 'http://localhost:5000', '*'];

app.use(cors({
  origin: (origin, callback) => {
    // Allow neural core, mobile nodes, and local development
    if (!origin || process.env.NODE_ENV !== 'production') return callback(null, true);

    // Auto-authorize all HelloPay Vercel and Tunnel subdomains
    const isAllowedTunnel = origin.includes('.loca.lt') || origin.includes('.vercel.app') || origin.includes('api.hellopayapp.com');
    
    if (allowedOrigins.includes(origin) || isAllowedTunnel) {
      return callback(null, true);
    }
    return callback(new Error(`CORS: Node [${origin}] not in Allowed Spectrum`), false);
  },
  credentials: true
}));
app.use(express.json());
app.use(cookieParser());

// Attach IO to request for controllers
app.use((req, res, next) => {
  req.io = io;
  next();
});

const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 2000, // High capacity for Admin Dashboard real-time activity
});

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500, // Standard protection for Public API
});

app.use('/api/admin', adminLimiter);
app.use('/api/', limiter);

const path = require('path');

// Serve static uploads with explicit CORS and CORP for cross-origin admin panel visibility
app.use('/uploads', (req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET");
  res.header("Cross-Origin-Resource-Policy", "cross-origin");
  next();
}, express.static(process.env.PERSISTENT_STORAGE_PATH || path.join(process.cwd(), 'uploads')));

// Routes
const { saveUpi } = require('./controllers/authController');
const { protect } = require('./middleware/authMiddleware');

app.use('/api/auth', authRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/transactions', transactionRoutes);
app.use('/api/recharge', require('./routes/rechargeRoutes'));
app.use('/api/listings', listingRoutes);
app.use('/api/stocks', require('./routes/stockRoutes'));
app.use('/api/support', require('./routes/supportRoutes'));
app.use('/api/tasks', require('./routes/taskRoutes'));

// 🚀 Future-Ready Payment Core (Razorpay)
app.use('/api/payments', require('./routes/paymentRoutes'));

// Neural Gift Code Module
app.use('/api/gift-codes', require('./routes/giftCodeRoutes'));

// Feature: Unique UPI Identity Flow
const { upload }  = require('./middleware/uploadMiddleware');
app.post('/api/save-upi', protect, upload.single('qrCode'), saveUpi);

app.get('/', (req, res) => res.send('HelloPay Neural API - Online'));
app.get('/api/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

app.use(errorHandler);
 
// Debug Endpoint to verify path resolution on Cloud Hosting
app.get('/api/debug-uploads', (req, res) => {
  const fs = require('fs');
  const path = require('path');
  const dir = path.join(process.cwd(), 'uploads');
  const exists = fs.existsSync(dir);
  const files = exists ? fs.readdirSync(dir) : [];
  res.json({
    cwd: process.cwd(),
    dirname: __dirname,
    uploadsDir: dir,
    exists,
    files_count: files.length,
    files: files.slice(0, 5) // first 5 files
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`HelloPay Neural Server running on port ${PORT}`));

io.on('connection', (socket) => {
  console.log('Admin/User Node Connected:', socket.id);
});
