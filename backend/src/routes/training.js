const express = require('express');
const router = express.Router();
const axios = require('axios');
const db = require('../db');
const requireAuth = require('../middleware/requireAuth');

async function getFreshStravaToken(userId) {
  const user = db.users.findBy('id', userId);
  if (!user?.strava_access_token) throw Object.assign(new Error('Strava not connected'), { code: 'NO_STRAVA' });

  const isExpired = Math.floor(Date.now() / 1000) > user.strava_token_expires_at - 300;
  if (!isExpired) return user.strava_access_token;

  const res = await axios.post('https://www.strava.com/oauth/token', {
    client_id: process.env.STRAVA_CLIENT_ID,
    client_secret: process.env.STRAVA_CLIENT_SECRET,
    refresh_token: user.strava_refresh_token,
    grant_type: 'refresh_token',
  });

  db.users.update(userId, {
    strava_access_token: res.data.access_token,
    strava_refresh_token: res.data.refresh_token,
    strava_token_expires_at: res.data.expires_at,
  });

  return res.data.access_token;
}

router.get('/activities', requireAuth, async (req, res) => {
  try {
    const token = await getFreshStravaToken(req.userId);
    const { page = 1, per_page = 20, before, after } = req.query;
    const { data } = await axios.get('https://www.strava.com/api/v3/athlete/activities', {
      headers: { Authorization: `Bearer ${token}` },
      params: { page, per_page, ...(before ? { before } : {}), ...(after ? { after } : {}) },
    });
    res.json(data);
  } catch (err) {
    if (err.code === 'NO_STRAVA') return res.status(403).json({ error: 'Strava not connected' });
    const stravaError = err.response?.data;
    console.error('Activities error:', stravaError ?? err.message);
    res.status(err.response?.status ?? 500).json({ error: 'Failed to fetch activities', detail: stravaError });
  }
});

router.get('/stats', requireAuth, async (req, res) => {
  try {
    const token = await getFreshStravaToken(req.userId);
    const user = db.users.findBy('id', req.userId);
    const { data } = await axios.get(`https://www.strava.com/api/v3/athletes/${user.strava_athlete_id}/stats`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    res.json(data);
  } catch (err) {
    if (err.code === 'NO_STRAVA') return res.status(403).json({ error: 'Strava not connected' });
    const stravaError = err.response?.data;
    console.error('Stats error:', stravaError ?? err.message);
    res.status(err.response?.status ?? 500).json({ error: 'Failed to fetch stats', detail: stravaError });
  }
});

module.exports = router;
