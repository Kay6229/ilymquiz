// api/send-report-email.js
// Sends the completed report to the customer via Resend

import { Resend } from 'resend';
import { createClient } from '@supabase/supabase-js';

const resend = new Resend(process.env.RESEND_API_KEY);
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { paidReportId } = req.body;

  if (!paidReportId) {
    return res.status(400).json({ error: 'Missing paidReportId' });
  }

  try {
    // Fetch the report
    const { data: report, error: fetchError } = await supabase
      .from('paid_reports')
      .select('*')
      .eq('id', paidReportId)
      .single();

    if (fetchError || !report) {
      return res.status(404).json({ error: 'Report not found' });
    }

    if (!report.customer_email) {
      return res.status(400).json({ error: 'No customer email on file' });
    }

    if (report.report_status !== 'complete' || !report.report_html) {
      return res.status(400).json({ error: 'Report not ready yet' });
    }

    if (report.email_sent) {
      return res.status(200).json({ success: true, alreadySent: true });
    }

    const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.ilymquiz.com';
    const reportUrl = `${siteUrl}/report?id=${report.id}`;
    const names = Array.isArray(report.player_names) ? report.player_names.join(' & ') : '';
    const tierName = report.tier === 'overview' ? 'The Overview' : 'The Full Report';

    // Simple HTML wrapper for the email body (different from the report HTML itself)
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

    const fromAddress = 'ILYMQuiz <reports@ilymquiz.com>';
    const subject = `Your ILYMQuiz report is ready 💕`;

    // Send the email
    const { data: resendData, error: resendError } = await resend.emails.send({
      from: fromAddress,
      to: report.customer_email,
      subject,
      html: emailHtml
    });

    if (resendError) {
      console.error('Resend send error:', resendError);
      return res.status(500).json({ error: 'Failed to send email' });
    }

    // Mark email as sent
    await supabase
      .from('paid_reports')
      .update({
        email_sent: true,
        email_sent_at: new Date().toISOString()
      })
      .eq('id', paidReportId);

    console.log(`Email sent for report ${paidReportId} to ${report.customer_email}`);

    return res.status(200).json({ success: true, emailId: resendData?.id });

  } catch (err) {
    console.error('send-report-email error:', err);
    return res.status(500).json({ error: err.message || 'Failed to send email' });
  }
}
