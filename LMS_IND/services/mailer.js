import nodemailer from "nodemailer";

let transporter;

export function mailConfigured() {
  return Boolean(
    process.env.MAIL_HOST &&
      process.env.MAIL_PORT &&
      process.env.MAIL_FROM_ADDRESS
  );
}

function getTransporter() {
  if (!mailConfigured()) {
    throw new Error("Email delivery is not configured.");
  }
  if (!transporter) {
    const port = Number(process.env.MAIL_PORT);
    transporter = nodemailer.createTransport({
      host: process.env.MAIL_HOST,
      port,
      secure: port === 465 || String(process.env.MAIL_SECURE).toLowerCase() === "true",
      auth: process.env.MAIL_USERNAME
        ? {
            user: process.env.MAIL_USERNAME,
            pass: process.env.MAIL_PASSWORD,
          }
        : undefined,
    });
  }
  return transporter;
}

export async function sendPasswordReset({ to, name, token }) {
  const appUrl = (process.env.APP_URL || "http://localhost:3000").replace(/\/$/, "");
  const resetUrl = `${appUrl}/reset-password?token=${encodeURIComponent(token)}`;
  const safeName = String(name || "there").replace(/[<>&]/g, "");
  const text = [
    `Hello ${safeName},`,
    "",
    "A password reset was requested for your Vanguard Learning account.",
    `Reset your password: ${resetUrl}`,
    "",
    "This link expires in 30 minutes and can only be used once.",
    "If you did not request this, you can ignore this email.",
  ].join("\n");

  return getTransporter().sendMail({
    from: process.env.MAIL_FROM_ADDRESS,
    to,
    subject: "Reset your Vanguard Learning password",
    text,
    html: `<p>Hello ${safeName},</p>
<p>A password reset was requested for your Vanguard Learning account.</p>
<p><a href="${resetUrl}">Reset your password</a></p>
<p>This link expires in 30 minutes and can only be used once. If you did not request this, you can ignore this email.</p>`,
  });
}
