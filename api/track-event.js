const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { event_type, referral_source, mode, session_id } = req.body;
    if (!event_type) return res.status(400).json({ error: 'event_type required' });

    const { error } = await supabase
      .from('funnel_events')
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
