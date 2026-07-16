const express = require('express');
const router = express.Router();
const axios = require('axios');
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const requireAuth = require('../middleware/requireAuth');

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// Frontend sends the Google credential (id_token) from the GoogleLogin component.
router.post('/google', async (req, res) => {
  const { credential } = req.body;
  if (!credential) return res.status(400).json({ error: 'credential required' });

  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const { sub: googleId, email, name, picture } = ticket.getPayload();

    let user = await db.users.findBy('google_id', googleId);
    if (!user) {
      const id = uuidv4();
      await db.users.insert({ id, email, name, picture, google_id: googleId });
      user = await db.users.findBy('id', id);
    }

    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.json({
      token,
      user: { id: user.id, email: user.email, name: user.name, picture: user.picture, hasStrava: !!user.strava_athlete_id },
    });
  } catch (err) {
    console.error('Google auth error:', err.message);
    res.status(401).json({ error: 'Google authentication failed' });
  }
});

// Browser redirect — token comes via query param since headers can't be set on redirects.
router.get('/strava-start', (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(401).json({ error: 'token required' });
  try {
    const { userId } = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = userId;
    stravaRedirect(req, res);
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
});

router.get('/strava', requireAuth, stravaRedirect);

function stravaRedirect(req, res) {
  const backendUrl = process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 3000}`;
  const redirectUri = `${backendUrl}/auth/strava/callback`;
  const state = jwt.sign({ userId: req.userId }, process.env.JWT_SECRET, { expiresIn: '10m' });

  const url = new URL('https://www.strava.com/oauth/authorize');
  url.searchParams.set('client_id', process.env.STRAVA_CLIENT_ID);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'read,activity:read_all');
  url.searchParams.set('state', state);

  res.redirect(url.toString());
}

// Strava redirects here after the user authorizes.
router.get('/strava/callback', async (req, res) => {
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
  const { code, state, error } = req.query;

  if (error || !code) return res.redirect(`${frontendUrl}/strava-error`);

  try {
    const { userId } = jwt.verify(state, process.env.JWT_SECRET);

    const tokenRes = await axios.post('https://www.strava.com/oauth/token', {
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
    });

    const { access_token, refresh_token, expires_at, athlete } = tokenRes.data;

    await db.users.update(userId, {
      strava_athlete_id: athlete.id,
      strava_access_token: access_token,
      strava_refresh_token: refresh_token,
      strava_token_expires_at: expires_at,
    });

    res.redirect(`${frontendUrl}/strava-connected`);
  } catch (err) {
    console.error('Strava callback error:', err.message);
    res.redirect(`${frontendUrl}/strava-error`);
  }
});

router.delete('/account', requireAuth, async (req, res) => {
  await db.users.remove(req.userId);
  await db.marathon_overview.removeByUserId(req.userId);
  await db.training_weeks.removeByUserId(req.userId);
  await db.run_reviews.removeByUserId(req.userId);
  res.json({ ok: true });
});

router.delete('/strava', requireAuth, async (req, res) => {
  await db.users.update(req.userId, {
    strava_athlete_id: null,
    strava_access_token: null,
    strava_refresh_token: null,
    strava_token_expires_at: null,
  });
  res.json({ ok: true });
});

router.get('/me', requireAuth, async (req, res) => {
  const user = await db.users.findBy('id', req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { strava_access_token, strava_refresh_token, ...safe } = user;
  res.json({ ...safe, hasStrava: !!user.strava_athlete_id });
});

module.exports = router;
