// api/check-report-status.js
// Called by the /report page every 2 seconds to check if the report is ready.
// Returns the report HTML once status is 'complete'.

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { id } = req.query;

  if (!id) {
    return res.status(400).json({ error: 'Missing report id' });
  }

  try {
    const { data: report, error } = await supabase
      .from('paid_reports')
      .select('id, tier, mode, payment_status, report_status, report_html, created_at')
      .eq('id', id)
      .single();

    if (error || !report) {
      return res.status(404).json({ error: 'Report not found' });
    }

    // If payment is not complete yet
    if (report.payment_status !== 'paid') {
      return res.status(200).json({
        status: 'awaiting_payment',
        paymentStatus: report.payment_status
      });
    }

    // If report is still being generated
    if (report.report_status === 'generating' || report.report_status === 'unpaid') {
      return res.status(200).json({
        status: 'generating',
        tier: report.tier,
        mode: report.mode
      });
    }

    // If report generation failed
    if (report.report_status === 'failed') {
      return res.status(200).json({
        status: 'failed',
        message: 'Report generation failed. Please contact support.'
      });
    }

    // Report is ready
    if (report.report_status === 'complete' && report.report_html) {
      return res.status(200).json({
        status: 'complete',
        tier: report.tier,
        mode: report.mode,
        reportHtml: report.report_html
      });
    }

    // Fallback
    return res.status(200).json({
      status: 'unknown',
      reportStatus: report.report_status
    });

  } catch (err) {
    console.error('check-report-status error:', err);
    return res.status(500).json({ error: err.message || 'Status check failed' });
  }
}
