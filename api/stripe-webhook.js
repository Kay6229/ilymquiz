// api/stripe-webhook.js
// Receives payment notifications from Stripe and handles the entire post-purchase flow
// inline: verify signature, update DB, call Claude to generate report, send email.
// This replaces the previous pattern of calling /api/generate-report separately,
// which failed because Vercel killed the webhook function before the background fetch fired.

import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
import Anthropic from '@anthropic-ai/sdk';
import { Resend } from 'resend';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const resend = new Resend(process.env.RESEND_API_KEY);

export const config = {
  api: { bodyParser: false },
  maxDuration: 300
};

// ---------- HELPERS ----------

async function getRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

const LABEL_CONFIG = {
  couple: ['Devoted Lover', 'All-in Lover', 'Warm Lover', 'Consistent Lover', 'Love in Progress'],
  friends: ['Devoted Friend', 'All-in Friend', 'Warm Friend', 'Consistent Friend', 'Friend in Progress'],
  siblings: ['Devoted Sibling', 'All-in Sibling', 'Warm Sibling', 'Consistent Sibling', 'Sibling in Progress']
};

function getLoveTypeLabel(mode, pct) {
  const labels = LABEL_CONFIG[mode] || LABEL_CONFIG.couple;
  if (pct >= 87) return labels[0];
  if (pct >= 70) return labels[1];
  if (pct >= 55) return labels[2];
  if (pct >= 40) return labels[3];
  return labels[4];
}

function getLangDisplay(mode) {
  const touchLabel = mode === 'couple' ? 'Physical Touch' : mode === 'friends' ? 'Physical Warmth' : 'Sibling Closeness';
  return {
    words: 'Words of Affirmation',
    gifts: 'Thoughtful Gifts',
    service: 'Acts of Service',
    time: 'Quality Time',
    touch: touchLabel,
    none: 'Neutral/Steady'
  };
}

// Escape user-supplied strings before splicing into HTML (questions/answers from DB)
function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Build Side by Side table + Note from Team as deterministic HTML, no LLM involved.
// - Overview tier: just the note section
// - Full tier: Side by Side (from real playerAnswers) + note section
// This prevents hallucinated questions — we use the actual playerAnswers from the DB.
function buildReportExtras(tier, mode, playerNames, playerAnswers) {
  const [nameA, nameB] = playerNames;

  // Side by Side — Full Report only
  let sideBySide = '';
  if (tier === 'full' && playerAnswers && playerAnswers[0] && playerAnswers[1]) {
    const a = playerAnswers[0];
    const b = playerAnswers[1];
    const qIndexes = Object.keys(a).map(n => parseInt(n, 10)).sort((x, y) => x - y);
    const rows = qIndexes.map(qi => {
      const qa = a[qi];
      const qb = b[qi];
      if (!qa || !qb) return '';
      const isMatch = qa.answerIdx === qb.answerIdx || (qa.text && qb.text && qa.text === qb.text);
      return `
        <div class="sbs-row${isMatch ? ' sbs-match' : ''}">
          <div class="sbs-row-head">
            <div class="sbs-qnum">Q${qi + 1}</div>
            <div class="sbs-qtext">${escapeHtml(qa.question || '')}</div>
            ${isMatch ? '<div class="sbs-match-badge">Match</div>' : ''}
          </div>
          <div class="sbs-row-answers">
            <div class="sbs-ans"><span class="sbs-ans-label sbs-ans-a">${escapeHtml(nameA)}</span><span class="sbs-ans-text">${escapeHtml(qa.text || '')}</span></div>
            <div class="sbs-ans"><span class="sbs-ans-label sbs-ans-b">${escapeHtml(nameB)}</span><span class="sbs-ans-text">${escapeHtml(qb.text || '')}</span></div>
          </div>
        </div>`;
    }).join('');

    sideBySide = `
  <div class="section">
    <div class="eyebrow">Section 04 · Receipts</div>
    <h2 class="h2">Side by side, <span class="accent">answer by answer.</span></h2>
    <p class="body-text">Every question. Both picks. Matches get a little green moment.</p>
    <div class="sbs-wrap">
      ${rows}
    </div>
  </div>`;
  }

  // Note from team — all tiers, mode-specific copy
  let noteBody;
  if (mode === 'friends') {
    noteBody = `
      <p class="note-body">We couldn't cover every inside joke, every late-night voice memo, or the thousand tiny ways friendship actually shows up. Nobody could.</p>
      <p class="note-body">The math is just the math. And only <strong>you</strong> know what you feel.</p>
      <p class="note-body">Take what's useful, laugh at the rest, and unless it makes you a better friend, don't make any drastic changes.</p>`;
  } else if (mode === 'siblings') {
    noteBody = `
      <p class="note-body">We couldn't possibly capture every childhood memory, every inside joke, or the thousand ways siblings actually show up for each other. Nobody could.</p>
      <p class="note-body">The math is just the math. And only <strong>you</strong> know what you feel.</p>
      <p class="note-body">Take what's useful, laugh at the rest, and unless it makes you closer, don't make any drastic changes.</p>`;
  } else {
    // couples (default)
    noteBody = `
      <p class="note-body">We didn't cover every aspect of chemistry 😏. And there are a thousand ways each of these moments could play out that we couldn't possibly list.</p>
      <p class="note-body">The math is just the math. And only <strong>you</strong> know what you feel.</p>
      <p class="note-body">Take what's useful, laugh at the rest, and unless it's to love your person better, don't make any drastic changes.</p>`;
  }

  const noteSection = `
  <div class="section note-section">
    <div class="note-card">
      <h2 class="note-title">A Note From Our Team</h2>${noteBody}
      <p class="note-sig">Xoxo, ILYMQuiz 💕</p>
    </div>
  </div>`;

  return sideBySide + noteSection;
}

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
    --peach: #e67e50;
    --peach-soft: #fdece2;
    --peach-deep: #a84718;
    --purple: #9d7fd4;
    --purple-soft: #f1ecfa;
    --purple-deep: #5f3ea3;
    --gold: #c9940a;
    --gold-soft: #fdf3d8;
    --ink: #111;
    --ink-soft: #444;
    --muted: #888;
    --paper: #fff;
    --bg: #f5f0ec;
    --sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: var(--sans); background: var(--bg); color: var(--ink); line-height: 1.6; padding: 32px 16px; -webkit-font-smoothing: antialiased; }
  .report { max-width: 720px; margin: 0 auto; background: var(--paper); border-radius: 24px; overflow: hidden; box-shadow: 0 12px 50px rgba(0,0,0,0.08); }
  .cover { background: linear-gradient(135deg, #fff, var(--pink-soft)); padding: 56px 48px 48px; text-align: center; position: relative; overflow: hidden; }
  .cover-logo { font-size: 13px; font-weight: 900; letter-spacing: 0.04em; margin-bottom: 28px; }
  .cover-logo span { color: var(--pink); }
  .cover-pill { display: inline-block; padding: 6px 16px; background: var(--pink); color: #fff; font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.14em; border-radius: 999px; margin-bottom: 20px; }
  .cover-pill.gold { background: linear-gradient(135deg, var(--gold), #7d5a00); }
  .cover-title { font-size: 54px; font-weight: 900; line-height: 1.0; letter-spacing: -0.03em; margin-bottom: 14px; }
  .cover-title .you { color: var(--pink); }
  .cover-sub { font-size: 17px; color: var(--ink-soft); font-weight: 500; margin-bottom: 32px; }
  .cover-meta { display: inline-flex; align-items: center; gap: 22px; padding: 14px 26px; background: rgba(255,255,255,0.85); border-radius: 16px; border: 1px solid rgba(212,83,126,0.18); }
  .cm-item { text-align: center; }
  .cm-label { font-size: 9px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.12em; font-weight: 800; margin-bottom: 3px; }
  .cm-val { font-size: 14px; font-weight: 800; color: var(--ink); }
  .cm-divider { width: 1px; height: 28px; background: rgba(0,0,0,0.12); }
  .winner { background: linear-gradient(135deg, #7d5a00, #c9940a, #f5d020, #c9940a, #7d5a00); color: #fff; text-align: center; padding: 44px 40px; }
  .winner-eyebrow { font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.18em; opacity: 0.9; margin-bottom: 10px; }
  .winner-trophy { font-size: 48px; margin-bottom: 6px; }
  .winner-name { font-size: 40px; font-weight: 900; letter-spacing: -0.02em; margin-bottom: 6px; }
  .winner-tagline { font-size: 16px; font-weight: 600; opacity: 0.95; }
  .section { padding: 44px 48px; }
  .section + .section { border-top: 1px solid #f1ebe7; }
  .eyebrow { font-size: 10px; font-weight: 800; color: var(--pink); text-transform: uppercase; letter-spacing: 0.18em; margin-bottom: 10px; }
  .h2 { font-size: 30px; font-weight: 900; letter-spacing: -0.02em; line-height: 1.15; margin-bottom: 20px; }
  .h2 .accent { color: var(--pink); }
  .body-text { font-size: 15.5px; color: var(--ink-soft); line-height: 1.75; margin-bottom: 16px; }
  .body-text strong { color: var(--ink); font-weight: 800; }
  .score-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; margin-top: 24px; }
  .score-card { border-radius: 18px; padding: 26px 22px; text-align: center; border: 2px solid; }
  .score-card.player-a { background: var(--pink-soft); border-color: var(--pink); }
  .score-card.player-b { background: var(--blue-soft); border-color: var(--blue); }
  .score-card.player-c { background: var(--peach-soft); border-color: var(--peach); }
  .score-card.player-d { background: var(--purple-soft); border-color: var(--purple); }
  .sc-name { font-size: 13px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 4px; }
  .player-a .sc-name { color: var(--pink-deep); }
  .player-b .sc-name { color: var(--blue-deep); }
  .player-c .sc-name { color: var(--peach-deep); }
  .player-d .sc-name { color: var(--purple-deep); }
  .sc-pct { font-size: 52px; font-weight: 900; line-height: 1; letter-spacing: -0.02em; }
  .player-a .sc-pct { color: var(--pink-deep); }
  .player-b .sc-pct { color: var(--blue-deep); }
  .player-c .sc-pct { color: var(--peach-deep); }
  .player-d .sc-pct { color: var(--purple-deep); }
  .sc-style { font-size: 15px; color: var(--ink); font-weight: 700; }
  .effort-badge { display: inline-block; margin-top: 12px; padding: 5px 14px; border-radius: 999px; font-size: 11px; font-weight: 800; letter-spacing: 0.08em; text-transform: uppercase; }
  .effort-badge.effort-high { background: #d8efe0; color: #1a6b34; }
  .effort-badge.effort-medium { background: #fce8c4; color: #8a5a06; }
  .effort-badge.effort-low { background: #fbd6d6; color: #8a1818; }
  .verdict { background: linear-gradient(135deg, var(--pink), var(--pink-deep)); color: #fff; text-align: center; padding: 48px 40px; }
  .verdict-eyebrow { font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.18em; opacity: 0.85; margin-bottom: 14px; }
  .verdict-headline { font-size: 24px; font-weight: 700; line-height: 1.35; margin-bottom: 24px; max-width: 480px; margin-left: auto; margin-right: auto; letter-spacing: -0.01em; }
  .verdict-score { display: inline-block; padding: 18px 44px; background: linear-gradient(135deg, #f5d020, #c9940a); border: 2px solid rgba(255,255,255,0.4); border-radius: 18px; }
  .verdict-score-num { font-size: 56px; font-weight: 900; line-height: 1; color: #4a3500; letter-spacing: -0.02em; }
  .verdict-score-label { font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.14em; color: #4a3500; opacity: 0.8; margin-top: 4px; }
  .pattern-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-top: 28px; }
  .pattern-card { border-radius: 18px; padding: 24px; border: 2px solid transparent; }
  .pattern-card.player-a { background: var(--pink-soft); border-color: rgba(212,83,126,0.25); }
  .pattern-card.player-b { background: var(--blue-soft); border-color: rgba(55,138,221,0.25); }
  .pattern-card.player-c { background: var(--peach-soft); border-color: rgba(230,126,80,0.25); }
  .pattern-card.player-d { background: var(--purple-soft); border-color: rgba(157,127,212,0.25); }
  .pattern-name { font-size: 13px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 4px; }
  .player-a .pattern-name { color: var(--pink-deep); }
  .player-b .pattern-name { color: var(--blue-deep); }
  .player-c .pattern-name { color: var(--peach-deep); }
  .player-d .pattern-name { color: var(--purple-deep); }
  .pattern-tag { font-size: 13px; color: var(--ink-soft); font-style: italic; margin-bottom: 14px; font-weight: 500; }
  .bar-row { margin-bottom: 12px; }
  .bar-label { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
  .bar-name { font-size: 12.5px; font-weight: 700; color: var(--ink); }
  .bar-pct { font-size: 12.5px; font-weight: 800; }
  .player-a .bar-pct { color: var(--pink-deep); }
  .player-b .bar-pct { color: var(--blue-deep); }
  .player-c .bar-pct { color: var(--peach-deep); }
  .player-d .bar-pct { color: var(--purple-deep); }
  .bar-track { height: 7px; background: rgba(255,255,255,0.7); border-radius: 999px; overflow: hidden; }
  .bar-fill { height: 100%; border-radius: 999px; min-width: 2px; }
  .player-a .bar-fill { background: linear-gradient(90deg, var(--pink), var(--pink-deep)); }
  .player-b .bar-fill { background: linear-gradient(90deg, var(--blue), var(--blue-deep)); }
  .player-c .bar-fill { background: linear-gradient(90deg, var(--peach), var(--peach-deep)); }
  .player-d .bar-fill { background: linear-gradient(90deg, var(--purple), var(--purple-deep)); }
  .bar-fill.zero { background: rgba(0,0,0,0.1) !important; }
  .gap-callout { background: #fff; border: 2px solid var(--pink); border-radius: 18px; padding: 28px; margin-top: 24px; position: relative; }
  .gap-tag { position: absolute; top: -12px; left: 24px; background: var(--pink); color: #fff; font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.12em; padding: 4px 12px; border-radius: 999px; }
  .gap-title { font-size: 21px; font-weight: 900; margin-bottom: 12px; letter-spacing: -0.01em; }
  .gap-desc { font-size: 15px; color: var(--ink-soft); line-height: 1.7; }
  .gap-desc strong { color: var(--ink); }
  .recs { margin-top: 24px; display: grid; gap: 16px; }
  .rec { display: flex; gap: 18px; padding: 24px; background: var(--gold-soft); border-radius: 16px; border: 1px solid #f0e0a0; }
  .rec-num { flex-shrink: 0; width: 44px; height: 44px; background: linear-gradient(135deg, var(--gold), #7d5a00); color: #fff; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: 900; font-size: 18px; }
  .rec-content { flex: 1; }
  .rec-title { font-size: 14px; font-weight: 900; color: var(--ink); margin-bottom: 8px; letter-spacing: 0.04em; text-transform: uppercase; line-height: 1.3; }
  .rec-desc { font-size: 14px; color: var(--ink-soft); line-height: 1.65; }
  .footer { text-align: center; padding: 28px 40px; background: #faf6f3; border-top: 1px solid #ece5e0; }
  .footer-logo { font-size: 13px; font-weight: 900; margin-bottom: 6px; }
  .footer-logo span { color: var(--pink); }
  .footer-text { font-size: 11px; color: var(--muted); font-weight: 600; }

  /* Side by Side table (Full Report only) */
  .sbs-wrap { margin-top: 24px; display: grid; gap: 10px; }
  .sbs-row { background: #fff; border: 1px solid #f1ebe7; border-radius: 12px; padding: 16px 18px; }
  .sbs-row.sbs-match { background: #f0f9f3; border-color: #c8e6d0; }
  .sbs-row-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 10px; }
  .sbs-qnum { font-size: 18px; font-weight: 900; color: var(--pink); line-height: 1; flex-shrink: 0; }
  .sbs-row.sbs-match .sbs-qnum { color: var(--green); }
  .sbs-qtext { font-size: 14px; font-weight: 700; color: var(--ink); line-height: 1.35; flex: 1; }
  .sbs-match-badge { font-size: 9px; font-weight: 900; background: var(--green); color: #fff; padding: 3px 8px; border-radius: 999px; letter-spacing: 0.08em; text-transform: uppercase; flex-shrink: 0; }
  .sbs-row-answers { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; padding-top: 10px; border-top: 1px solid #f5f0ec; }
  .sbs-row.sbs-match .sbs-row-answers { border-top-color: #c8e6d0; }
  .sbs-ans { display: flex; flex-direction: column; gap: 4px; }
  .sbs-ans-label { font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.08em; }
  .sbs-ans-label.sbs-ans-a { color: var(--pink-deep); }
  .sbs-ans-label.sbs-ans-b { color: var(--blue-deep); }
  .sbs-ans-text { font-size: 13px; color: var(--ink-soft); line-height: 1.5; }

  /* Note from team (closing section) */
  .note-section { background: linear-gradient(180deg, #fff, var(--pink-soft)); }
  .note-card { text-align: center; max-width: 520px; margin: 0 auto; }
  .note-title { font-size: 28px; font-weight: 900; color: var(--ink); letter-spacing: -0.02em; line-height: 1.15; margin-bottom: 24px; }
  .note-body { font-size: 15.5px; color: var(--ink-soft); line-height: 1.75; margin-bottom: 14px; }
  .note-body strong { color: var(--ink); font-weight: 800; }
  .note-sig { font-size: 15px; color: var(--pink-deep); font-weight: 700; margin-top: 20px; }

  /* Mobile adjustments — desktop unchanged above */
  @media (max-width: 640px) {
    body { padding: 16px 8px; }
    .report { border-radius: 18px; }

    /* Cover */
    .cover { padding: 40px 22px 36px; }
    .cover-title { font-size: 40px; }
    .cover-sub { font-size: 15px; margin-bottom: 24px; }
    .cover-meta {
      display: flex;
      flex-direction: column;
      gap: 10px;
      padding: 14px 18px;
      width: 100%;
      max-width: 320px;
      align-items: center;
    }
    .cm-divider { display: none; }

    /* Winner */
    .winner { padding: 36px 22px; }
    .winner-name { font-size: 32px; }
    .winner-tagline { font-size: 14px; line-height: 1.5; }

    /* All sections */
    .section { padding: 32px 22px; }
    .h2 { font-size: 24px; }
    .body-text { font-size: 15px; }

    /* Score grid — stack vertically on mobile */
    .score-grid { grid-template-columns: 1fr; gap: 14px; }
    .score-card { padding: 22px 18px; }
    .sc-pct { font-size: 48px; }
    .sc-style { font-size: 14px; }
    .effort-badge { font-size: 10px; padding: 4px 12px; margin-top: 10px; }

    /* Verdict */
    .verdict { padding: 36px 22px; }
    .verdict-headline { font-size: 20px; line-height: 1.4; }
    .verdict-score-num { font-size: 46px; }
    .verdict-score { padding: 14px 32px; }

    /* Pattern grid — stack vertically */
    .pattern-grid { grid-template-columns: 1fr; gap: 16px; }
    .pattern-card { padding: 20px 18px; }

    /* Gap callout */
    .gap-callout { padding: 24px 18px; }
    .gap-title { font-size: 19px; }

    /* Recs — fix the overflowing number badge layout */
    .rec { padding: 20px 16px; gap: 14px; }
    .rec-num { width: 38px; height: 38px; font-size: 16px; }
    .rec-title { font-size: 13px; line-height: 1.35; }
    .rec-desc { font-size: 13.5px; }

    /* Side by Side — stack answers vertically on mobile */
    .sbs-row { padding: 14px 16px; }
    .sbs-qnum { font-size: 16px; }
    .sbs-qtext { font-size: 13px; }
    .sbs-row-answers { grid-template-columns: 1fr; gap: 8px; }
    .sbs-ans-text { font-size: 13px; }

    /* Note section */
    .note-title { font-size: 22px; margin-bottom: 18px; }
    .note-body { font-size: 14.5px; }
    .note-sig { font-size: 14px; }

    /* Footer */
    .footer { padding: 24px 20px; }
    .footer-text { font-size: 10.5px; }
  }
</style>
`;

function buildPrompt(report) {
  const { mode, tier, player_names, player_scores, player_lang_totals, player_answers } = report;
  const maxPossible = 44;
  const pcts = player_scores.map(s => Math.round((s / maxPossible) * 100));
  const langDisplay = getLangDisplay(mode);

  const perPlayerData = player_names.map((name, i) => {
    const label = getLoveTypeLabel(mode, pcts[i]);
    const langs = player_lang_totals[i] || {};
    // Locked order — same for every player so users can compare horizontally.
    // 'none' (wishy-washy answers) is intentionally excluded — its info is now
    // surfaced via the Effort Level badge on the score card.
    const orderedKeys = ['words', 'time', 'service', 'gifts', 'touch'];
    const allKeys = ['words', 'gifts', 'service', 'time', 'touch', 'none'];
    const totalAll = allKeys.reduce((s, k) => s + (langs[k] || 0), 0) || 1;
    const breakdown = orderedKeys.map(k => ({
      key: k,
      display: langDisplay[k],
      count: langs[k] || 0,
      pct: Math.round(((langs[k] || 0) / totalAll) * 100)
    }));
    // Effort level derived from total score percentage
    let effortLevel, effortClass;
    if (pcts[i] >= 70) { effortLevel = 'High Effort'; effortClass = 'effort-high'; }
    else if (pcts[i] >= 40) { effortLevel = 'Medium Effort'; effortClass = 'effort-medium'; }
    else { effortLevel = 'Low Effort'; effortClass = 'effort-low'; }
    return { name, score: player_scores[i], pct: pcts[i], label, breakdown, effortLevel, effortClass };
  });

  const dataBlock = perPlayerData.map(p => {
    const breakdownStr = p.breakdown.map(b => `   - ${b.display}: ${b.pct}% (${b.count} answers)`).join('\n');
    return `${p.name}:
  Score: ${p.score}/${maxPossible} (${p.pct}%)
  Official Label: ${p.label}
  Effort Level: ${p.effortLevel} (CSS class: ${p.effortClass})
  Language breakdown (use these EXACT percentages and EXACT order, show ALL FIVE including 0%):
${breakdownStr}`;
  }).join('\n\n');

  const dateStr = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const tierLabel = tier === 'overview' ? 'The Overview · $5.99' : 'The Full Report · $10.99';
  const tierPillClass = tier === 'full' ? 'gold' : '';
  const winnerIdx = player_scores.indexOf(Math.max(...player_scores));
  const winnerName = player_names[winnerIdx];
  const isMulti = player_names.length > 2;

  // Mode + player-count specific headline for the Love Gap section
  let gapHeadline;
  if (isMulti && mode === 'friends') {
    gapHeadline = `The <span class="accent">Friendship Gap.</span>`;
  } else if (isMulti && mode === 'siblings') {
    gapHeadline = `The <span class="accent">Sibling Gap.</span>`;
  } else {
    gapHeadline = `The one thing you're <span class="accent">getting wrong</span> about each other.`;
  }

  // Multi-player sentence for the all-players rule in the prompt
  const multiPlayerRule = isMulti
    ? `\n- MULTI-PLAYER MODE (${player_names.length} players): The Love Gap section MUST reference every player by name: ${player_names.join(', ')}. Do not leave anyone out.`
    : '';

  const reportExtras = buildReportExtras(tier, mode, player_names, player_answers);
  const prompt = `You are writing a personalized relationship compatibility report for ILYMQuiz ("No, I Love YOU More"). Tone: playful, warm, witty, BuzzFeed-meets-relationship-coach. Short punchy sentences. Specific to THIS pair. Avoid em-dashes; use periods or commas. Keep paragraphs tight (2-3 sentences max). Prioritize pithy and clever over long and explanatory.

MODE: ${mode}
TIER: ${tier}
DATE: ${dateStr}

PLAYER DATA (use these EXACT labels and percentages — do NOT invent new ones):

${dataBlock}

WINNER: ${winnerName}

CRITICAL RULES:
- The "Official Label" above (e.g. "Warm Lover", "All-in Lover") is what you MUST put in the sc-style field for each player. Do NOT invent custom labels.
- Show all FIVE language categories in each player's pattern card, in the EXACT order provided, including those at 0%. Do not hide any. Do not reorder.
- Each score-card must include an effort badge using the CSS class provided (effort-high, effort-medium, or effort-low).
- Use the EXACT percentages provided above.${multiPlayerRule}

Write a complete HTML document wrapped in the structure below. Do NOT include <html>, <head>, or <body> tags. Start with "<!-- REPORT START -->" and end with "<!-- REPORT END -->".

<!-- REPORT START -->
<div class="report">

  <div class="cover">
    <div class="cover-logo"><span>ILYM</span>Quiz</div>
    <div class="cover-pill ${tierPillClass}">${tierLabel}</div>
    <h1 class="cover-title">No, I Love <span class="you">YOU</span> More.</h1>
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
    <div class="winner-name">${winnerName}</div>
    <div class="winner-tagline">[Short witty tagline about the margin, ~12 words]</div>
  </div>

  <div class="section">
    <div class="eyebrow">The Receipts</div>
    <h2 class="h2">Here's how each of you <span class="accent">actually scored.</span></h2>
    <p class="body-text">[Short 1-2 sentence setup]</p>
    <div class="score-grid">
      [For each player IN THE EXACT ORDER PROVIDED ABOVE, produce a score-card with the slot class: first player = "player-a", second = "player-b", third = "player-c", fourth = "player-d". Include in this order inside the card: sc-name (player's name, uppercase), sc-pct (their percentage), sc-style (their EXACT Official Label), and an effort-badge div with the EXACT CSS class provided (e.g. <div class="effort-badge effort-high">High Effort</div>).]
    </div>
  </div>

  <div class="verdict">
    <div class="verdict-eyebrow">The Verdict</div>
    <p class="verdict-headline">"[Witty BuzzFeed-style headline specific to this pair, ~15 words]"</p>
    <div class="verdict-score">
      <div class="verdict-score-num">[avg compatibility %]</div>
      <div class="verdict-score-label">Compatibility</div>
    </div>
  </div>

  <div class="section">
    <div class="eyebrow">Section 01 · How You Love</div>
    <h2 class="h2">[Specific witty headline about their love styles]</h2>
    <p class="body-text">[2-3 sentences describing the key pattern between the two]</p>
    <div class="pattern-grid">
      [TWO pattern-cards, one per player. Each has pattern-name (player's name uppercase + "'S LOVE PATTERN"), pattern-tag (italic one-liner, ~5 words), and SIX bar-row entries for every language category from their breakdown. Every bar-row has bar-name, bar-pct, and bar-track with bar-fill styled inline as width:X% — when X is 0, add class "zero" to the bar-fill.]
    </div>
  </div>

  <div class="section">
    <div class="eyebrow">Section 02 · The Love Gap</div>
    <h2 class="h2">${gapHeadline}</h2>
    <p class="body-text">[Setup sentence]</p>
    <div class="gap-callout">
      <div class="gap-tag">Your Top Love Gap</div>
      <h3 class="gap-title">[Specific gap title, ~8 words]</h3>
      <p class="gap-desc">[2-3 sentence description with <strong> on key words]</p>
    </div>
  </div>

  <div class="section">
    <div class="eyebrow">Section 03 · What To Do About It</div>
    <h2 class="h2">Three things that'll <span class="accent">actually</span> move the needle.</h2>
    <p class="body-text">[Setup sentence]</p>
    <div class="recs">
      [THREE rec divs. Each MUST follow this EXACT structure with elements in this EXACT order — do not rearrange, do not skip, do not add wrappers:
      <div class="rec"><div class="rec-num">1</div><div class="rec-content"><div class="rec-title">PLAYER NAME: TITLE IN ALL CAPS</div><div class="rec-desc">Two sentences, concrete and actionable.</div></div></div>
      Repeat for rec-num 2 and rec-num 3. The rec-num div MUST always come first (before rec-content), followed by rec-content containing rec-title and rec-desc.]
    </div>
  </div>
<!-- EXTRAS_PLACEHOLDER -->
  <div class="footer">
    <div class="footer-logo"><span>ILYM</span>Quiz</div>
    <div class="footer-text">ilymquiz.com · Generated for ${player_names.join(' & ')} · ${dateStr}</div>
  </div>

</div>
<!-- REPORT END -->

REMINDERS:
- sc-style MUST use the Official Label provided, not an invented one.
- Each score card MUST include the effort-badge div with the exact CSS class given.
- Pattern cards MUST show all 5 language categories in the EXACT order given, even at 0%.
- Use the EXACT percentages provided.
- Do not output anything outside REPORT START/END comments.
- Do not include <style>, <html>, or <body> tags.
- Keep the literal "<!-- EXTRAS_PLACEHOLDER -->" comment exactly where it is — we will splice real content there after.
`;
  return { prompt, reportExtras };
}

async function generateReportForId(paidReportId) {
  const { data: report, error: fetchError } = await supabase
    .from('paid_reports')
    .select('*')
    .eq('id', paidReportId)
    .single();

  if (fetchError || !report) {
    console.error('Report fetch error:', fetchError);
    return { ok: false, reason: 'not_found' };
  }

  const { prompt, reportExtras } = buildPrompt(report);

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 8000,
    messages: [{ role: 'user', content: prompt }]
  });

  let rawHtml = '';
  for (const block of message.content) {
    if (block.type === 'text') rawHtml += block.text;
  }

  const startMarker = '<!-- REPORT START -->';
  const endMarker = '<!-- REPORT END -->';
  const startIdx = rawHtml.indexOf(startMarker);
  const endIdx = rawHtml.indexOf(endMarker);

  if (startIdx === -1 || endIdx === -1) {
    console.error('Claude did not return expected markers');
    await supabase.from('paid_reports').update({ report_status: 'failed' }).eq('id', paidReportId);
    return { ok: false, reason: 'no_markers' };
  }

  let reportBody = rawHtml.substring(startIdx + startMarker.length, endIdx).trim();
  // Splice deterministic extras (Side by Side + Note from Team) in place of the placeholder.
  // If Claude dropped the placeholder, fall back to appending before the footer.
  if (reportBody.includes('<!-- EXTRAS_PLACEHOLDER -->')) {
    reportBody = reportBody.replace('<!-- EXTRAS_PLACEHOLDER -->', reportExtras);
  } else if (reportExtras) {
    reportBody = reportBody.replace(/<div class="footer">/, reportExtras + '\n<div class="footer">');
  }
  const fullHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Your ILYMQuiz Report</title>
${REPORT_CSS}
</head>
<body>
${reportBody}
</body>
</html>`;

  const { error: updateError } = await supabase
    .from('paid_reports')
    .update({ report_html: fullHtml, report_status: 'complete' })
    .eq('id', paidReportId);

  if (updateError) {
    console.error('Save report error:', updateError);
    return { ok: false, reason: 'save_failed' };
  }

  return { ok: true, report };
}

async function sendReportEmail(report) {
  if (!report.customer_email) return { ok: false, reason: 'no_email' };

  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.ilymquiz.com';
  const reportUrl = `${siteUrl}/report?id=${report.id}`;
  const names = Array.isArray(report.player_names) ? report.player_names.join(' & ') : '';
  const tierName = report.tier === 'overview' ? 'The Overview' : 'The Full Report';

  const emailHtml = `
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f5f0ec; margin: 0; padding: 40px 20px; color: #111; }
  .wrap { max-width: 560px; margin: 0 auto; background: #fff; border-radius: 16px; padding: 40px 36px; box-shadow: 0 8px 24px rgba(0,0,0,0.06); }
  .logo { font-size: 18px; font-weight: 900; margin-bottom: 24px; letter-spacing: -0.5px; }
  .logo span { color: #D4537E; }
  h1 { font-size: 26px; font-weight: 900; letter-spacing: -0.5px; margin: 0 0 12px; line-height: 1.2; }
  p { font-size: 15px; line-height: 1.7; color: #444; margin: 0 0 16px; }
  .btn { display: inline-block; padding: 14px 28px; background: #D4537E; color: #fff !important; text-decoration: none; border-radius: 999px; font-weight: 800; font-size: 15px; margin: 14px 0 8px; }
  .footer { margin-top: 32px; padding-top: 20px; border-top: 1px solid #eee; font-size: 12px; color: #999; }
  .footer a { color: #999; }
</style>
</head>
<body>
  <div class="wrap">
    <div class="logo"><span>ILYM</span>Quiz</div>
    <h1>Your report is ready ${names ? `for ${names}` : ''} 💕</h1>
    <p>Thanks for buying <strong>${tierName}</strong>. We wrote your personalized relationship report based on everything you and your person answered.</p>
    <p>It's all there: scores, love styles, your biggest love gap, and 3 things you can actually do about it.</p>
    <p><a href="${reportUrl}" class="btn">View your report →</a></p>
    <p style="font-size:13px;color:#888;">Bookmark the link. You can come back to this report anytime.</p>
    <div class="footer">
      Sent from ILYMQuiz. Questions? Just reply to this email.<br>
      <a href="https://www.ilymquiz.com">ilymquiz.com</a>
    </div>
  </div>
</body>
</html>
  `.trim();

  const { data: resendData, error: resendError } = await resend.emails.send({
    from: 'ILYMQuiz <reports@ilymquiz.com>',
    to: report.customer_email,
    subject: 'Your ILYMQuiz report is ready 💕',
    html: emailHtml
  });

  if (resendError) {
    console.error('Resend error:', resendError);
    return { ok: false, reason: 'resend_failed' };
  }

  await supabase
    .from('paid_reports')
    .update({ email_sent: true, email_sent_at: new Date().toISOString() })
    .eq('id', report.id);

  return { ok: true, emailId: resendData?.id };
}

// ---------- MAIN HANDLER ----------

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!webhookSecret) {
    console.error('STRIPE_WEBHOOK_SECRET not configured');
    return res.status(500).json({ error: 'Webhook secret not configured' });
  }

  let event;
  try {
    const rawBody = await getRawBody(req);
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).json({ error: `Webhook Error: ${err.message}` });
  }

  if (event.type !== 'checkout.session.completed') {
    // Not a checkout completion — acknowledge and move on
    return res.status(200).json({ received: true });
  }

  const session = event.data.object;
  const paidReportId = session.metadata?.paid_report_id;
  const customerEmail = session.customer_details?.email || session.customer_email;

  if (!paidReportId) {
    console.error('No paid_report_id in session metadata');
    return res.status(400).json({ error: 'Missing paid_report_id' });
  }

  // Step 1: mark payment as paid immediately
  const { error: updateError } = await supabase
    .from('paid_reports')
    .update({
      payment_status: 'paid',
      paid_at: new Date().toISOString(),
      customer_email: customerEmail,
      report_status: 'generating'
    })
    .eq('id', paidReportId);

  if (updateError) {
    console.error('Supabase update error:', updateError);
    return res.status(500).json({ error: 'Failed to update payment status' });
  }

  console.log(`Payment completed for report ${paidReportId}`);

  // Step 2: generate the report inline (stay within this function)
  try {
    const genResult = await generateReportForId(paidReportId);
    if (!genResult.ok) {
      console.error('Report generation failed:', genResult.reason);
      // Still acknowledge the webhook so Stripe doesn't retry
      return res.status(200).json({ received: true, generationFailed: true });
    }

    console.log(`Report generated for ${paidReportId}`);

    // Step 3: send the email
    const emailResult = await sendReportEmail(genResult.report);
    if (!emailResult.ok) {
      console.error('Email send failed:', emailResult.reason);
      // Report is saved, email can be retried manually. Acknowledge webhook either way.
      return res.status(200).json({ received: true, emailFailed: true });
    }

    console.log(`Email sent for report ${paidReportId}`);
    return res.status(200).json({ received: true, complete: true });

  } catch (err) {
    console.error('Post-payment processing error:', err);
    await supabase.from('paid_reports').update({ report_status: 'failed' }).eq('id', paidReportId);
    // Still acknowledge so Stripe doesn't spam retries
    return res.status(200).json({ received: true, error: err.message });
  }
}
