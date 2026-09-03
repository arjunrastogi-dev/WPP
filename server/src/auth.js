import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { config } from './config.js';
import { Users } from './store.js';

/**
 * Password hashing uses scrypt from node:crypto — deliberately no bcrypt
 * dependency, since npm 11 sandboxes native install scripts.
 *
 * Format stored in the DB: `salt:derivedKey`, both hex.
 */

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const key = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${key}`;
}

export function verifyPassword(password, stored) {
  const [salt, key] = String(stored).split(':');
  if (!salt || !key) return false;
  const candidate = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(key, 'hex');
  // Constant-time compare; timingSafeEqual throws on length mismatch.
  if (candidate.length !== expected.length) return false;
  return crypto.timingSafeEqual(candidate, expected);
}

export const signToken = (user) =>
  jwt.sign({ sub: user.id, username: user.username, role: user.role }, config.jwtSecret, {
    expiresIn: config.jwtExpiry,
  });

export function verifyToken(token) {
  try {
    return jwt.verify(token, config.jwtSecret);
  } catch {
    return null;
  }
}

/** Creates the seed admin the first time the app runs against an empty DB. */
export async function ensureSeedUser() {
  if (await Users.count() > 0) return null;
  const user = await Users.create({
    username: config.adminUser,
    passwordHash: hashPassword(config.adminPass),
    role: 'admin',
  });
  console.log(`[auth] seeded admin user "${user.username}" (change ADMIN_PASS in production)`);
  return user;
}

/** Express middleware: rejects anything without a valid Bearer token. */
export function requireAuth(req, res, next) {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const claims = token ? verifyToken(token) : null;
  if (!claims) return res.status(401).json({ error: 'Unauthorized' });
  req.user = { id: claims.sub, username: claims.username, role: claims.role };
  next();
}

export function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}

/**
 * Guard for server-to-server callers (the clinic CMS), which authenticate with
 * a shared API key instead of a user login.
 */
export function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'];
  if (!key || key !== config.apiKey) {
    return res.status(401).json({ error: 'Invalid or missing X-API-Key', code: 'UNAUTHORIZED' });
  }
  next();
}

/** Socket.IO handshake auth — same token, different transport. */
export function socketAuth(socket, next) {
  const token = socket.handshake.auth?.token;
  const claims = token ? verifyToken(token) : null;
  if (!claims) return next(new Error('Unauthorized'));
  socket.data.user = { id: claims.sub, username: claims.username, role: claims.role };
  next();
}
