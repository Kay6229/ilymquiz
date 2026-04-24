// api/generate-report.js
// Called by the Stripe webhook after a successful payment.
// Fetches quiz data, calls Claude to write the report, saves HTML, triggers email.

import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export const config = {
  maxDuration: 60 // allow up to 60 seconds for Claude to finish
};

// Brand CSS reused in every report
const REPORT_CSS = `
<style>
  :root {
    --pink: #D4537E;
    --pink-soft: #fbeaf0;
    --pink-deep: #a83866;
    --green: #22a355;
    --green-soft: #e8f7ee;
    --blue: #378ADD;
    --blue-soft: #e6f1fb;
    --blue-deep: #185FA5;
    --gold: #c9940a;
    --gold-soft: #fdf3d8;
    --ink: #111;
    --ink-soft: #444;
    --muted: #888;
    --paper: #fff;
    --bg: #f5f0ec;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Plus Jakarta Sans', -apple-system, sans-serif; background: var(--bg); color: var(--ink); line-height: 1.6; padding: 32px 16px; -webkit-font-smoothing: antialiased; }
  .report { max-width: 720px; margin: 0 auto; background: var(--paper); border-radius: 24px; overflow: hidden; box-shadow: 0 12px 50px rgba(0,0,0,0.08); }
  .cover { background: linear-gradient(135deg, #fff, var(--pink-soft)); padding: 56px 48px 48px; text-align: center; position: relative; overflow: hidden; }
  .cover-logo { font-size: 13px; font-weight: 900; letter-spacing: 0.04em; margin-bottom: 28px; }
  .cover-logo span { color: var(--pink); }
  .cover-pill { display: inline-block; padding: 6px 16px; background: var(--pink); color: #fff; font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.14em; border-radius: 999px; margin-bottom: 20px; }
  .cover-pill.gold { background: linear-gradient(135deg, var(--gold), #7d5a00); }
  .cover-title { font-family: 'Fraunces', Georgia, serif; font-size: 60px; font-weight: 900; line-height: 0.95; letter-spacing: -0.035em; margin-bottom: 14px; }
  .cover-title .you { color: var(--pink); font-style: italic; }
  .cover-sub { font-family: 'Fraunces', Georgia, serif; font-style: italic; font-size: 19px; color: var(--ink-soft); margin-bottom: 32px; }
  .cover-meta { display: inline-flex; align-items: center; gap: 22px; padding: 14px 26px; background: rgba(255,255,255,0.85); border-radius: 16px; border: 1px solid rgba(212,83,126,0.18); }
  .cm-item { text-align: center; }
  .cm-label { font-size: 9px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.12em; font-weight: 800; margin-bottom: 3px; }
  .cm-val { font-size: 14px; font-weight: 800; color: var(--ink); }
  .cm-divider { width: 1px; height: 28px; background: rgba(0,0,0,0.12); }
  .winner { background: linear-gradient(135deg, #7d5a00, #c9940a, #f5d020, #c9940a, #7d5a00); color: #fff; text-align: center; padding: 44px 40px; }
  .winner-eyebrow { font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.18em; opacity: 0.9; margin-bottom: 10px; }
  .winner-trophy { font-size: 48px; margin-bottom: 6px; }
  .winner-name { font-family: 'Fraunces', Georgia, serif; font-size: 44px; font-weight: 900; letter-spacing: -0.025em; margin-bottom: 6px; }
  .winner-tagline { font-family: 'Fraunces', Georgia, serif; font-style: italic; font-size: 17px; opacity: 0.95; }
  .section { padding: 44px 48px; }
  .section + .section { border-top: 1px solid #f1ebe7; }
  .eyebrow { font-size: 10px; font-weight: 800; color: var(--pink); text-transform: uppercase; letter-spacing: 0.18em; margin-bottom: 10px; }
  .h2 { font-family: 'Fraunces', Georgia, serif; font-size: 32px; font-weight: 900; letter-spacing: -0.025em; line-height: 1.1; margin-bottom: 20px; }
  .h2 .accent { color: var(--pink); }
  .body-text { font-size: 15.5px; color: var(--ink-soft); line-height: 1.75; margin-bottom: 16px; }
  .body-text strong { color: var(--ink); font-weight: 800; }
  .score-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; margin-top: 24px; }
  .score-card { border-radius: 18px; padding: 26px 22px; text-align: center; border: 2px solid; }
  .score-card.player-a { background: var(--pink-soft); border-color: var(--pink); }
  .score-card.player-b { background: var(--blue-soft); border-color: var(--blue); }
  .sc-name { font-size: 13px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 4px; }
  .player-a .sc-name { color: var(--pink-deep); }
  .player-b .sc-name { color: var(--blue-deep); }
  .sc-pct { font-family: 'Fraunces', Georgia, serif; font-size: 56px; font-weight: 900; line-height: 1; }
  .player-a .sc-pct { color: var(--pink-deep); }
  .player-b .sc-pct { color: var(--blue-deep); }
  .sc-style { font-family: 'Fraunces', Georgia, serif; font-style: italic; font-size: 16px; color: var(--ink); font-weight: 700; }
  .verdict { background: linear-gradient(135deg, var(--pink), var(--pink-deep)); color: #fff; text-align: center; padding: 48px 40px; }
  .verdict-eyebrow { font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.18em; opacity: 0.85; margin-bottom: 14px; }
  .verdict-headline { font-family: 'Fraunces', Georgia, serif; font-style: italic; font-size: 28px; font-weight: 700; line-height: 1.3; margin-bottom: 24px; max-width: 480px; margin-left: auto; margin-right: auto; }
  .verdict-score { display: inline-block; padding: 18px 44px; background: linear-gradient(135deg, #f5d020, #c9940a); border: 2px solid rgba(255,255,255,0.4); border-radius: 18px; }
  .verdict-score-num { font-family: 'Fraunces', Georgia, serif; font-size: 64px; font-weight: 900; line-height: 1; color: #4a3500; }
  .verdict-score-label { font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.14em; color: #4a3500; opacity: 0.8; margin-top: 4px; }
  .pattern-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-top: 28px; }
  .pattern-card { border-radius: 18px; padding: 24px; border: 2px solid transparent; }
  .pattern-card.player-a { background: var(--pink-soft); border-color: rgba(212,83,126,0.25); }
  .pattern-card.player-b { background: var(--blue-soft); border-color: rgba(55,138,221,0.25); }
  .pattern-name { font-size: 13px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 4px; }
  .player-a .pattern-name { color: var(--pink-deep); }
  .player-b .pattern-name { color: var(--blue-deep); }
  .bar-row { margin-bottom: 12px; }
  .bar-label { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
  .bar-name { font-size: 12.5px; font-weight: 700; color: var(--ink); }
  .bar-pct { font-size: 12.5px; font-weight: 800; }
  .player-a .bar-pct { color: var(--pink-deep); }
  .player-b .bar-pct { color: var(--blue-deep); }
  .bar-track { height: 7px; background: rgba(255,255,255,0.7); border-radius: 999px; overflow: hidden; }
  .bar-fill { height: 100%; border-radius: 999px; }
  .player-a .bar-fill { background: linear-gradient(90deg, var(--pink), var(--pink-deep)); }
  .player-b .bar-fill { background: linear-gradient(90deg, var(--blue), var(--blue-deep)); }
  .gap-callout { background: #fff; border: 2px solid var(--pink); border-radius: 18px; padding: 28px; margin-top: 24px; position: relative; }
  .gap-tag { position: absolute; top: -12px; left: 24px; background: var(--pink); color: #fff; font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.12em; padding: 4px 12px; border-radius: 999px; }
  .gap-title { font-family: 'Fraunces', Georgia, serif; font-size: 22px; font-weight: 900; margin-bottom: 12px; }
  .gap-desc { font-size: 15px; color: var(--ink-soft); line-height: 1.7; }
  .gap-desc strong { color: var(--ink); }
  .recs { margin-top: 24px; display: grid; gap: 16px; }
  .rec { display: flex; gap: 18px; padding: 24px; background: var(--gold-soft); border-radius: 16px; border: 1px solid #f0e0a0; }
  .rec-num { flex-shrink: 0; width: 44px; height: 44px; background: linear-gradient(135deg, var(--gold), #7d5a00); color: #fff; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-family: 'Fraunces', Georgia, serif; font-weight: 900; font-size: 20px; font-style: italic; }
  .rec-content { flex: 1; }
  .rec-title { font-size: 14px; font-weight: 900; color: var(--ink); margin-bottom: 8px; letter-spacing: 0.04em; text-transform: uppercase; line-height: 1.3; }
  .rec-desc { font-size: 14px; color: var(--ink-soft); line-height: 1.65; }
  .footer { text-align: center; padding: 28px 40px; background: #faf6f3; border-top: 1px solid #ece5e0; }
  .footer-logo { font-size: 13px; font-weight: 900; margin-bottom: 6px; }
  .footer-logo span { color: var(--pink); }
  .footer-text { font-size: 11px; color: var(--muted); font-weight: 600; }
</style>
`;

// Build the prompt we send to Claude
function buildPrompt(report) {
  const { mode, tier, player_names, player_scores, player_lang_totals, player_surveys } = report;

  const maxPossible = mode === 'couple' ? 44 : 44; // 11 questions * 4 max points
  const pcts = player_scores.map(s => Math.round((s / maxPossible) * 100));

  const playerSummary = player_names.map((name, i) => {
    const langs = player_lang_totals[i] || {};
    const langStr = Object.entries(langs)
      .filter(([k, v]) => v > 0)
      .map(([k, v]) => `${k}:${v}`)
      .join(', ');
    return `- ${name}: score ${player_scores[i]}/${maxPossible} (${pcts[i]}%), language picks: ${langStr}`;
  }).join('\n');

  const dateStr = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

  const tierLabel = tier === 'overview' ? 'The Overview · $5.99' : 'The Full Report · $10.99';
  const tierPillClass = tier === 'full' ? 'gold' : '';

  const fullReportExtras = tier === 'full' ? `

4. A Section 04 "Side by Side" showing every question and what each player picked, color-coded
5. A Section 05 "How Scoring Works" explaining the +1 to +4 scale
` : '';

  return `You are writing a personalized relationship compatibility report for the product ILYMQuiz ("No, I Love YOU More"). The tone is playful, warm, witty, and BuzzFeed-meets-relationship-coach. Use short punchy sentences mixed with conversational observations. Be specific to THIS pair, not generic. Avoid em-dashes; use periods or commas.

QUIZ DATA:
- Mode: ${mode}
- Tier: ${tier}
- Date: ${dateStr}
- Players:
${playerSummary}

Love language keys: words=Words of affirmation, gifts=Thoughtful gifts, time=Quality time, service=Acts of service, touch=Physical ${mode === 'couple' ? 'touch' : mode === 'friends' ? 'warmth' : 'closeness'}, none=neutral/steady answer.

WINNER: ${player_names[player_scores.indexOf(Math.max(...player_scores))]} (highest score).

Your task: Write a complete HTML document wrapped in the structure below. Do NOT include <html>, <head>, or <body> tags. Start your output with the comment "<!-- REPORT START -->" and end with "<!-- REPORT END -->". In between, produce the full report HTML exactly following this structure:

<!-- REPORT START -->
<div class="report">

  <div class="cover">
    <div class="cover-logo"><span>ILYM</span>Quiz</div>
    <div class="cover-pill ${tierPillClass}">${tierLabel}</div>
    <h1 class="cover-title">No, I Love<br><span class="you">YOU</span> More.</h1>
    <p class="cover-sub">Built on science. Delivered with vibes.</p>
    <div class="cover-meta">
      <div class="cm-item"><div class="cm-label">For</div><div class="cm-val">${player_names.join(' & ')}</div></div>
      <div class="cm-divider"></div>
      <div class="cm-item"><div class="cm-label">Mode</div><div class="cm-val">${mode.charAt(0).toUpperCase() + mode.slice(1)}</div></div>
      <div class="cm-divider"></div>
      <div class="cm-item"><div class="cm-label">Date</div><div class="cm-val">${dateStr}</div></div>
    </div>
  </div>

  <div class="winner">
    <div class="winner-eyebrow">The Official Winner</div>
    <div class="winner-trophy">🏆</div>
    <div class="winner-name">[WINNER NAME]</div>
    <div class="winner-tagline">[Short witty tagline about the margin, ~12 words]</div>
  </div>

  <div class="section">
    <div class="eyebrow">The Receipts</div>
    <h2 class="h2">Here's how each of you <span class="accent">actually scored.</span></h2>
    <p class="body-text">[Short 1-2 sentence setup]</p>
    <div class="score-grid">
      [Two score-cards with class "player-a" and "player-b", each containing sc-name, sc-pct, sc-style (an invented love-style label like "The Thoughtful Architect")]
    </div>
  </div>

  <div class="verdict">
    <div class="verdict-eyebrow">The Verdict</div>
    <p class="verdict-headline">"[Witty BuzzFeed-style headline about this specific pair, ~15 words]"</p>
    <div class="verdict-score">
      <div class="verdict-score-num">[avg compatibility %]</div>
      <div class="verdict-score-label">Compatibility</div>
    </div>
  </div>

  <div class="section">
    <div class="eyebrow">Section 01 · How You Love</div>
    <h2 class="h2">[Specific witty headline about their love styles]</h2>
    <p class="body-text">[2-3 sentences describing the key pattern between the two, referencing actual score distribution]</p>
    <div class="pattern-grid">
      [Two pattern-cards, each with pattern-name, pattern-tagline in italics, and bar-rows for each love language they scored on. Use real percentages from the data above. Convert count to % of their answers.]
    </div>
  </div>

  <div class="section">
    <div class="eyebrow">Section 02 · The Love Gap</div>
    <h2 class="h2">The one thing you're <span class="accent">getting wrong</span> about each other.</h2>
    <p class="body-text">[Setup sentence]</p>
    <div class="gap-callout">
      <div class="gap-tag">Your Top Love Gap</div>
      <h3 class="gap-title">[Specific gap title based on data, ~8 words]</h3>
      <p class="gap-desc">[2-3 sentence description of the gap with <strong> tags on key words]</p>
    </div>
  </div>

  <div class="section">
    <div class="eyebrow">Section 03 · What To Do About It</div>
    <h2 class="h2">Three things that'll <span class="accent">actually</span> move the needle.</h2>
    <p class="body-text">[Setup sentence]</p>
    <div class="recs">
      [THREE rec divs, each with rec-num (1, 2, 3) and rec-content containing rec-title (ALL CAPS, specific to a player by name) and rec-desc (~2 sentences, concrete and actionable)]
    </div>
  </div>
${fullReportExtras}
  <div class="footer">
    <div class="footer-logo"><span>ILYM</span>Quiz</div>
    <div class="footer-text">ilymquiz.com · Generated for ${player_names.join(' & ')} · ${dateStr}</div>
  </div>

</div>
<!-- REPORT END -->

IMPORTANT:
- Use the REAL names, REAL scores, REAL language percentages from the data
- Make every paragraph specific to THIS pair
- Keep the playful tone throughout
- Do not output anything outside the REPORT START/END comments
- Do not include <style>, <html>, or <body> tags — just the content div
`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { paidReportId } = req.body;

  if (!paidReportId) {
    return res.status(400).json({ error: 'Missing paidReportId' });
  }

  try {
    // Fetch the report data
    const { data: report, error: fetchError } = await supabase
      .from('paid_reports')
      .select('*')
      .eq('id', paidReportId)
      .single();

    if (fetchError || !report) {
      console.error('Report fetch error:', fetchError);
      return res.status(404).json({ error: 'Report not found' });
    }

    if (report.payment_status !== 'paid') {
      return res.status(400).json({ error: 'Report has not been paid for' });
    }

    // Build the prompt
    const prompt = buildPrompt(report);

    // Call Claude
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 8000,
      messages: [{ role: 'user', content: prompt }]
    });

    let rawHtml = '';
    for (const block of message.content) {
      if (block.type === 'text') rawHtml += block.text;
    }

    // Extract content between REPORT START and REPORT END
    const startMarker = '<!-- REPORT START -->';
    const endMarker = '<!-- REPORT END -->';
    const startIdx = rawHtml.indexOf(startMarker);
    const endIdx = rawHtml.indexOf(endMarker);

    if (startIdx === -1 || endIdx === -1) {
      console.error('Claude did not return expected markers');
      await supabase
        .from('paid_reports')
        .update({ report_status: 'failed' })
        .eq('id', paidReportId);
      return res.status(500).json({ error: 'Report generation failed' });
    }

    const reportBody = rawHtml.substring(startIdx + startMarker.length, endIdx).trim();

    // Build full HTML document
    const fullHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Your ILYMQuiz Report</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,wght@0,400;0,700;0,900;1,700&family=Plus+Jakarta+Sans:wght@400;600;700;800;900&display=swap" rel="stylesheet">
${REPORT_CSS}
</head>
<body>
${reportBody}
</body>
</html>`;

    // Save to database
    const { error: updateError } = await supabase
      .from('paid_reports')
      .update({
        report_html: fullHtml,
        report_status: 'complete'
      })
      .eq('id', paidReportId);

    if (updateError) {
      console.error('Save report error:', updateError);
      return res.status(500).json({ error: 'Failed to save report' });
    }

    // Trigger email send (fire and forget)
    const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.ilymquiz.com';
    fetch(`${siteUrl}/api/send-report-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paidReportId })
    }).catch(err => {
      console.error('Failed to trigger email:', err);
    });

    return res.status(200).json({ success: true });

  } catch (err) {
    console.error('generate-report error:', err);
    await supabase
      .from('paid_reports')
      .update({ report_status: 'failed' })
      .eq('id', paidReportId);
    return res.status(500).json({ error: err.message || 'Report generation failed' });
  }
}
