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
    const { mode, playerNames, playerPhones, playerCount, quizLocation } = req.body;

    // Create session in Supabase
    const { data: session, error } = await supabase
      .from('sessions')
      .insert([{
        mode,
        player_names: JSON.stringify(playerNames),
        player_phones: JSON.stringify(playerPhones),
        player_count: playerCount,
        quiz_location: quizLocation,
        status: 'pending'
      }])
      .select()
      .single();

    if (error) throw error;

    const sessionId = session.id;
    const baseUrl = 'https://www.ilymquiz.com';

    // Send each player their unique link
    const smsPromises = playerNames.map((name, index) => {
      const phone = playerPhones[index];
      if (!phone) return Promise.resolve();
      const link = `${baseUrl}/quiz?session=${sessionId}&player=${index}`;
      const message = `Hey ${name}! It is your turn to take the ILYM Quiz. Click your unique link to start: ${link}`;
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
    res.status(500).json({ error: error.message });
  }
};
