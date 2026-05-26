const express = require('express');
const router = express.Router();
const { getAlerts } = require('../controllers/alertController');

// Route: GET /api/alerts
router.get('/', getAlerts);

module.exports = router;