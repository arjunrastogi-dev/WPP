import { Router } from 'express';
import { route } from '../http.js';
import { Users } from '../store.js';
import { hashPassword, verifyPassword, signToken, requireAuth, requireAdmin } from '../auth.js';

const router = Router();

router.post('/login', route(async (req, res) => {
  const { username, password } = req.body ?? {};
  if (!username || !password) return res.status(400).json({ error: 'username and password are required' });

  const user = await Users.byName(username);
  // Same message and no early return for an unknown user, so the response
  // doesn't reveal which usernames exist.
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  res.json({
    token: signToken(user),
    user: { id: user.id, username: user.username, role: user.role },
  });
}));

/**
 * Self-service signup. A new account owns only the sessions it creates, so an
 * open registration doesn't expose anyone else's WhatsApp.
 */
router.post('/register', route(async (req, res) => {
  const { username, password } = req.body ?? {};

  if (!username?.trim() || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }
  if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(username.trim())) {
    return res.status(400).json({
      error: 'Username must be 3-32 characters: letters, numbers, dot, dash or underscore',
    });
  }
  if (String(password).length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  if (await Users.byName(username.trim())) {
    return res.status(409).json({ error: 'That username is taken' });
  }

  const user = await Users.create({
    username: username.trim(),
    passwordHash: hashPassword(password),
    role: 'agent',
  });

  // Sign them straight in — a signup that then demands a login is busywork.
  res.status(201).json({ token: signToken(user), user });
}));

router.get('/me', requireAuth, (req, res) => res.json({ user: req.user }));

router.get('/users', requireAuth, requireAdmin, route(async (req, res) => res.json(await Users.list())));

router.post('/users', requireAuth, requireAdmin, route(async (req, res) => {
  const { username, password, role } = req.body ?? {};
  if (!username || !password) return res.status(400).json({ error: 'username and password are required' });
  if (await Users.byName(username)) return res.status(409).json({ error: 'Username already taken' });
  res.status(201).json(await Users.create({ username, passwordHash: hashPassword(password), role }));
}));

export default router;
