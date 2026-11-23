require('dotenv').config();
const nodemailer = require('nodemailer');

(async () => {
  try {
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: Number(process.env.SMTP_PORT) === 465,
      auth: {
        user: process.env.SMTP_USERNAME,
        pass: process.env.SMTP_PASSWORD,
      },
    });

    await transporter.verify();
    console.log('SMTP connection verified successfully.');
  } catch (err) {
    console.error('SMTP verification failed:', err.message);
    if (err.stack) {
      console.error(err.stack);
    }
  }
})();
