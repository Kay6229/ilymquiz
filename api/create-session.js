const { createClient } = require('@supabase/supabase-js');
const twilio = require('twilio');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// ---------- INPUT HARDENING ----------
// This endpoint sends SMS on our Twilio account, which makes it a target for
// SMS-pumping / toll fraud. Every input is validated server-side, US/CA numbers
// only, and per-IP rate limiting backed by Supabase. Twilio Geo Permissions
// should ALSO be restricted to US/CA in the Twilio console (defense in depth).

const VALID_MODES = ['couple', 'friends', 'siblings'];
const MAX_PLAYERS = 4; // matches the UI (couple=2, friends/siblings up to 4)
const MAX_NAME_LEN = 30;
const RATE_LIMIT_MAX = 5;          // sessions per IP...
const RATE_LIMIT_WINDOW_MIN = 60;  // ...per hour

// Normalize to E.164 and require US/CA (+1, 10 digits, valid NANP shape).
function normalizeUsCaPhone(raw) {
  if (typeof raw !== 'string') return null;
  const digits = raw.replace(/\D/g, '');
  let ten = null;
  if (digits.length === 10) ten = digits;
  else if (digits.length === 11 && digits[0] === '1') ten = digits.slice(1);
  if (!ten) return null;
  // NANP: area code and exchange can't start with 0 or 1
  if (ten[0] === '0' || ten[0] === '1') return null;
  if (ten[3] === '0' || ten[3] === '1') return null;
  return '+1' + ten;
}

// Names go into the SMS body — keep them short, plain text, no links.
function sanitizeName(raw) {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LEN);
  if (!cleaned) return null;
  if (/https?:|www\.|\.[a-z]{2,6}\/|[<>]/i.test(cleaned)) return null; // no URLs/markup
  return cleaned;
}

function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

// Per-IP rate limit using the existing Supabase instance (no new services).
// Requires table:
//   create table if not exists rate_limits (
//     id bigint generated always as identity primary key,
//     bucket text not null,
//     ip text not null,
//     created_at timestamptz not null default now());
//   create index if not exists rate_limits_lookup
//     on rate_limits (bucket, ip, created_at);
// If the table is missing we fail OPEN (real users unaffected) but log loudly.
async function checkRateLimit(ip) {
  try {
    const windowStart = new Date(Date.now() - RATE_LIMIT_WINDOW_MIN * 60 * 1000).toISOString();
    const { count, error } = await supabase
      .from('rate_limits')
      .select('id', { count: 'exact', head: true })
      .eq('bucket', 'create-session')
      .eq('ip', ip)
      .gte('created_at', windowStart);
    if (error) {
      console.error('rate_limits table error (failing open):', error.message);
      return true;
    }
    if ((count || 0) >= RATE_LIMIT_MAX) return false;
    await supabase.from('rate_limits').insert({ bucket: 'create-session', ip });
    return true;
  } catch (err) {
    console.error('Rate limit check failed (failing open):', err.message);
    return true;
  }
}

module.exports = async (req, res) => {
  // Same-origin only — no CORS headers on purpose. The site calls this from
  // ilymquiz.com itself; cross-origin browser calls get blocked by default.
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { mode, playerNames, playerPhones, playerCount, quizLocation } = req.body || {};

    // ---- Validation ----
    if (!VALID_MODES.includes(mode)) {
      return res.status(400).json({ error: 'Invalid mode' });
    }
    if (!Array.isArray(playerNames) || !Array.isArray(playerPhones)) {
      return res.status(400).json({ error: 'Invalid players' });
    }
    const count = playerNames.length;
    const maxForMode = mode === 'couple' ? 2 : MAX_PLAYERS;
    if (count < 2 || count > maxForMode || playerPhones.length !== count || playerCount !== count) {
      return res.status(400).json({ error: 'Invalid player count' });
    }

    const cleanNames = playerNames.map(sanitizeName);
    if (cleanNames.some(n => n === null)) {
      return res.status(400).json({ error: 'Invalid player name' });
    }

    // Player 1 never receives an SMS; everyone else needs a valid US/CA number.
    const cleanPhones = playerPhones.map((p, i) => {
      if (i === 0) return p ? normalizeUsCaPhone(p) : null;
      return normalizeUsCaPhone(p);
    });
    for (let i = 1; i < count; i++) {
      if (!cleanPhones[i]) {
        return res.status(400).json({ error: 'Please use valid US or Canada phone numbers' });
      }
    }
    // Reject duplicate recipient numbers (classic pumping pattern)
    const recipients = cleanPhones.slice(1);
    if (new Set(recipients).size !== recipients.length) {
      return res.status(400).json({ error: 'Duplicate phone numbers' });
    }

    // ---- Rate limit ----
    const ip = getClientIp(req);
    const allowed = await checkRateLimit(ip);
    if (!allowed) {
      return res.status(429).json({ error: 'Too many quiz sessions from this device. Try again later.' });
    }

    // ---- Create session ----
    const { data: session, error } = await supabase
      .from('sms_sessions')
      .insert([{
        mode,
        player_names: JSON.stringify(cleanNames),
        player_phones: JSON.stringify(cleanPhones),
        player_count: count,
        quiz_location: quizLocation === 'distance' ? 'distance' : 'same',
        status: 'pending'
      }])
      .select()
      .single();

    if (error) throw error;

    const sessionId = session.id;
    const baseUrl = 'https://www.ilymquiz.com';
    const challenger = cleanNames[0];

    const modePhrase = mode === 'friends'
      ? 'thinks they are the better friend'
      : mode === 'siblings'
        ? 'thinks they are the better sibling'
        : 'is certain they love you more';

    // Send each player (except Player 1) their unique link
    const smsPromises = cleanNames.map((name, index) => {
      if (index === 0) return Promise.resolve();
      const phone = cleanPhones[index];
      if (!phone) return Promise.resolve();
      const link = baseUrl + '/quiz?session=' + sessionId + '&player=' + index;
      const message = 'Hey ' + name + '! ' + challenger + ' ' + modePhrase + '. They just took the No, I Love YOU More Quiz to prove it — and they are challenging you to play. ' + link;
      return twilioClient.messages.create({
        body: message,
        messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID,
        to: phone
      });
    });

    await Promise.all(smsPromises);

    res.status(200).json({
      success: true,
      sessionId,
      message: 'Session created and links sent'
    });

  } catch (error) {
    console.error('Create session error:', error);
    res.status(500).json({ error: 'Could not create session' });
  }
};
