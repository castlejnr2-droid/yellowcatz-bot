const express = require('express');
const cors = require('cors');
const path = require('path');
const rateLimit = require('express-rate-limit');
const apiRoutes = require('./routes/api');
const adminRoutes = require('./routes/admin');
require('dotenv').config();

function createServer() {
  const app = express();

  app.use(cors());
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Rate limiting
  const limiter = rateLimit({ windowMs: 60 * 1000, max: 100 });
  app.use('/api/', limiter);

  // Static files (website)
  app.use(express.static(path.join(__dirname, '../../public')));

  // API routes
  app.use('/api', apiRoutes);
  app.use('/api/admin', adminRoutes);

  // Serve index.html for all other routes (SPA fallback)
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../../public/index.html'));
  });

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`🌐 Website running at http://localhost:${PORT}`);
  });

  return app;
}

module.exports = { createServer };
