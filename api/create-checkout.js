// api/create-checkout.js
// When user clicks "Get the Overview" or "Get the Full Report" on results page:
// 1. Saves their quiz data to Supabase
// 2. Creates a Stripe checkout session
// 3. Returns the Stripe URL so frontend can redirect them to pay
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
export default async function handler(req, res) {
  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const {
      tier,              // 'overview' or 'full'
      mode,              // 'couple' | 'friends' | 'siblings'
      playerNames,       // ['Maya', 'Jordan']
      playerScores,      // [38, 32]
      playerLangTotals,  // [{time:3, words:2, ...}, {...}]
      playerSurveys,     // [{ll:"...", dyn:"...", ...}, {...}]
      playerAnswers      // full Q+A pairs (only for Full Report)
    } = req.body;
    // Basic validation
    if (!tier || !mode || !playerNames || !playerScores || !playerLangTotals) {
      return res.status(400).json({ error: 'Missing required quiz data' });
    }
    if (tier !== 'overview' && tier !== 'full') {
      return res.status(400).json({ error: 'Invalid tier' });
    }
    // Full Report is couples only
    if (tier === 'full' && mode !== 'couple') {
      return res.status(400).json({ error: 'Full Report is for couples only' });
    }
    // Step 1: Save quiz data to Supabase (status: unpaid)
    const { data: reportRow, error: dbError } = await supabase
      .from('paid_reports')
      .insert({
        mode,
        player_names: playerNames,
        player_scores: playerScores,
        player_lang_totals: playerLangTotals,
        player_surveys: playerSurveys || [],
        player_answers: playerAnswers || null,
        tier,
        payment_status: 'pending',
        report_status: 'unpaid'
      })
      .select()
      .single();
    if (dbError) {
      console.error('Supabase insert error:', dbError);
      return res.status(500).json({ error: 'Failed to save quiz data' });
    }
    // Step 2: Pick the right Stripe price ID based on tier
    const priceId = tier === 'overview'
      ? process.env.STRIPE_OVERVIEW_PRICE_ID
      : process.env.STRIPE_FULL_PRICE_ID;
    const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.ilymquiz.com';
    // Step 3: Create Stripe checkout session
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      allow_promotion_codes: true,
      line_items: [
        {
          price: priceId,
          quantity: 1
        }
      ],
      success_url: `${siteUrl}/report?id=${reportRow.id}`,
      cancel_url: `${siteUrl}/?canceled=true`,
      metadata: {
        paid_report_id: reportRow.id,
        tier,
        mode
      }
    });
    // Step 4: Update Supabase row with the Stripe session ID
    await supabase
      .from('paid_reports')
      .update({ stripe_session_id: session.id })
      .eq('id', reportRow.id);
    // Step 5: Send the Stripe checkout URL back to the frontend
    return res.status(200).json({
      success: true,
      checkoutUrl: session.url,
      paidReportId: reportRow.id
    });
  } catch (err) {
    console.error('create-checkout error:', err);
    return res.status(500).json({
      error: err.message || 'Something went wrong'
    });
  }
}
