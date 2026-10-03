'use strict';

const crypto = require('node:crypto');

const SESSION_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days
const INVITE_TTL = 14 * 24 * 60 * 60 * 1000; // 14 days
const COOKIE = 'swipio_session';

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  if (!stored) return false;
  const [saltHex, hashHex] = stored.split(':');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

function randomToken() {
  return crypto.randomBytes(24).toString('base64url');
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    try {
      out[key] = decodeURIComponent(part.slice(idx + 1).trim());
    } catch {
      // ignore malformed cookie values
    }
  }
  return out;
}

module.exports = {
  SESSION_TTL,
  INVITE_TTL,
  COOKIE,
  hashPassword,
  verifyPassword,
  randomToken,
  parseCookies,
};
