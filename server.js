'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { openDb } = require('./src/db');
const { createApp } = require('./src/app');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = openDb(path.join(DATA_DIR, 'swipio.db'));

const app = createApp({
  db,
  uploadDir: path.join(DATA_DIR, 'uploads'),
  publicUrl: process.env.PUBLIC_URL,
  secureCookies: process.env.SECURE_COOKIES === 'true',
});

// Close expired collections even when nobody is using the app.
setInterval(() => {
  try {
    app.finalizeDue();
  } catch (err) {
    console.error('Failed to finalize collections', err);
  }
}, 30_000).unref();

app.listen(PORT, () => {
  console.log(`Swipio is running on http://localhost:${PORT}`);
});
