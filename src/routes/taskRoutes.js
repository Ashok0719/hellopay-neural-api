const express = require('express');
const router = express.Router();
const { getTasks, claimTask } = require('../controllers/taskController');
const { protect } = require('../middleware/authMiddleware');

router.get('/', protect, getTasks);
router.post('/claim/:type', protect, claimTask);

module.exports = router;
