// api/stripe-webhook.js
// Stripe calls this URL when a payment event happens (success, fail, etc.)
// We verify the message is really from Stripe, then update our database.

import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Vercel needs this config: don't auto-parse the body (we need the raw bytes to verify Stripe signature)
export const config = {
  api: {
    bodyParser: false
  }
};

// Helper to read the raw request body
async function getRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

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

  // We only care about successful payments
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const paidReportId = session.metadata?.paid_report_id;
    const customerEmail = session.customer_details?.email || session.customer_email;

    if (!paidReportId) {
      console.error('No paid_report_id in session metadata');
      return res.status(400).json({ error: 'Missing paid_report_id' });
    }

    // Update Supabase: mark as paid, save email, mark report as generating
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

    // Kick off report generation (fire and forget, don't wait)
    // We call our own generate-report endpoint in the background
    const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.ilymquiz.com';
    fetch(`${siteUrl}/api/generate-report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paidReportId })
    }).catch(err => {
      console.error('Failed to trigger report generation:', err);
      // Don't fail the webhook — Stripe just needs to know we got the event
    });

    console.log(`Payment completed for report ${paidReportId}`);
  }

  // Tell Stripe we received the event successfully
  return res.status(200).json({ received: true });
}
