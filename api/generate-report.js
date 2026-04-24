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
  .body-text { font-size: 15.5px; color: var(--i
