const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { sessionId } = req.query;
    if (!sessionId) return res.status(400).json({ error: 'sessionId required' });

    // Get session
    const { data: session, error: sessionError } = await supabase
      .from('sessions')
      .select('*')
      .eq('id', sessionId)
      .single();

    if (sessionError) throw sessionError;

    // Get all responses for this session
    const { data: responses, error: responsesError } = await supabase
      .from('responses')
      .select('*')
      .eq('session_id', sessionId)
      .order('player_index', { ascending: true });

    if (responsesError) throw responsesError;

    const totalPlayers = session.player_count;
    const submittedCount = responses.length;
    const allDone = submittedCount >= totalPlayers;
    const playerNames = JSON.parse(session.player_names);

    // Build leaderboard from submitted responses
    const leaderboard = responses.map((r) => {
      const score = JSON.parse(r.scores);
      const maxPts = 44;
      const pct = Math.round(score / maxPts * 100);
      return {
        name: r.player_name,
        playerIndex: r.player_index,
        score,
        pct,
        langTotals: JSON.parse(r.lang_totals),
        surveyAnswers: JSON.parse(r.survey_answers)
      };
    }).sort((a, b) => b.score - a.score);

    // Build pending list
    const submittedIndexes = responses.map(r => r.player_index);
    const pending = playerNames
      .map((name, i) => ({ name, index: i }))
      .filter(p => !submittedIndexes.includes(p.index))
      .map(p => p.name);

    res.status(200).json({
      success: true,
      sessionId,
      mode: session.mode,
      totalPlayers,
      submittedCount,
      allDone,
      status: session.status,
      leaderboard,
      pending
    });

  } catch (error) {
    console.error('Check completion error:', error);
    res.status(500).json({ error: error.message });
  }
};
