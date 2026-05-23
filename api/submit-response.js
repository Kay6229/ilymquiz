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

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { sessionId, playerIndex, playerName, scores, langTotals, surveyAnswers } = req.body;

    // Save this player's response
    const { error: insertError } = await supabase
      .from('responses')
      .insert([{
        session_id: sessionId,
        player_index: playerIndex,
        player_name: playerName,
        scores: JSON.stringify(scores),
        lang_totals: JSON.stringify(langTotals),
        survey_answers: JSON.stringify(surveyAnswers)
      }]);

    if (insertError) throw insertError;

    // Check how many responses exist for this session
    const { data: responses, error: countError } = await supabase
      .from('responses')
      .select('*')
      .eq('session_id', sessionId);

    if (countError) throw countError;

    // Get the session to find total player count
    const { data: session, error: sessionError } = await supabase
      .from('sessions')
      .select('*')
      .eq('id', sessionId)
      .single();

    if (sessionError) throw sessionError;

    const totalPlayers = session.player_count;
    const submittedCount = responses.length;
    const allDone = submittedCount >= totalPlayers;

    if (allDone) {
      // Mark session complete
      await supabase
        .from('sessions')
        .update({ status: 'complete', completed_at: new Date().toISOString() })
        .eq('id', sessionId);

      // Build results text and send to everyone
      const playerNames = JSON.parse(session.player_names);
      const playerPhones = JSON.parse(session.player_phones);
      const mode = session.mode;

      // Sort responses by score descending
      const sorted = responses.sort((a, b) => {
        const scoreA = JSON.parse(a.scores);
        const scoreB = JSON.parse(b.scores);
        return scoreB - scoreA;
      });

      const medals = ['🥇', '🥈', '🥉'];
      let resultsHeader = `🩷 No, I Love YOU More — the results are in!\n\n`;
      sorted.forEach((r, i) => {
        const score = JSON.parse(r.scores);
        const maxPts = 44;
        const pct = Math.round(score / maxPts * 100);
        resultsHeader += `${medals[i] || '#' + (i + 1)} ${r.player_name}: ${pct}%\n`;
      });
      // Text each player a personalized link to their own results
      const smsPromises = playerPhones.map((phone, idx) => {
        if (!phone) return Promise.resolve();
        const personalLink = `https://www.ilymquiz.com/?session=${sessionId}&player=${idx}`;
        const personalText = resultsHeader + `\nTap to see your full breakdown:\n${personalLink}\n\n#ILYMQuiz`;
        return twilioClient.messages.create({
          body: personalText,
          messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID,
          to: phone
        });
      });
      await Promise.all(smsPromises);

      return res.status(200).json({
        success: true,
        allDone: true,
        submittedCount,
        totalPlayers,
        message: 'All done — results sent to everyone'
      });
    }

    res.status(200).json({
      success: true,
      allDone: false,
      submittedCount,
      totalPlayers,
      message: `${submittedCount} of ${totalPlayers} submitted`
    });

  } catch (error) {
    console.error('Submit response error:', error);
    res.status(500).json({ error: error.message });
  }
};
