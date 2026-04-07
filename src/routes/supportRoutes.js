const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const { handleChatRequest } = require('../controllers/supportController');

// All support requests are protected as they require user context
router.post('/chat', protect, handleChatRequest);

module.exports = router;
