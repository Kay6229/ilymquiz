const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Same-origin only — CORS headers removed so other sites' scripts can't
// spam our analytics. Values are length-capped to keep the table clean.
const cap = (v, n) => (typeof v === 'string' ? v.slice(0, n) : null);

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    let { event_type, referral_source, mode, session_id } = req.body || {};
    event_type = cap(event_type, 50);
    referral_source = cap(referral_source, 100);
    mode = cap(mode, 20);
    session_id = cap(session_id, 60);
    if (!event_type) return res.status(400).json({ error: 'event_type required' });

    const { error } = await supabase
      .from('visitor_activity')
      .insert({
        event_type,
        referral_source: referral_source || null,
        mode: mode || null,
        session_id: session_id || null
      });

    if (error) throw error;
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('track-event error:', err);
    return res.status(500).json({ error: err.message });
  }
};
