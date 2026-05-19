const sgMail = require('@sendgrid/mail');

// Safelist of origins allowed to invoke this API
const ALLOWED_ORIGINS = [
  'https://naveenh.in',
  'https://www.naveenh.in',
  'http://localhost:3000',
  'http://localhost:5500',
  'http://localhost:8080',
  'http://127.0.0.1:5500',
  'http://127.0.0.1:3000'
];

/**
 * HTTP Google Cloud Function to handle contact form submissions and email them via SendGrid.
 * 
 * @param {Object} req Cloud Function request context.
 * @param {Object} res Cloud Function response context.
 */
exports.contactForm = async (req, res) => {
  const origin = req.headers.origin;

  // Set dynamic CORS headers if origin is in the allowed safelist
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.set('Access-Control-Allow-Origin', origin);
  } else {
    // Default fallback (doesn't allow cross-origin requests from random sites)
    res.set('Access-Control-Allow-Origin', 'https://naveenh.in');
  }

  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');

  // Handle preflight CORS OPTIONS requests instantly
  if (req.method === 'OPTIONS') {
    return res.status(204).send('');
  }

  // Enforce POST requests only
  if (req.method !== 'POST') {
    return res.status(405).json({
      status: 'error',
      message: 'Method Not Allowed. Only POST requests are accepted.'
    });
  }

  // Retrieve and validate input fields
  const { name, email, subject, message } = req.body || {};

  if (!name || !name.trim()) {
    return res.status(400).json({ status: 'error', message: 'Name is a required field.' });
  }
  if (!email || !email.trim() || !email.includes('@')) {
    return res.status(400).json({ status: 'error', message: 'A valid email address is required.' });
  }
  if (!subject || !subject.trim()) {
    return res.status(400).json({ status: 'error', message: 'Subject is a required field.' });
  }
  if (!message || !message.trim()) {
    return res.status(400).json({ status: 'error', message: 'Message is a required field.' });
  }

  // Ensure SendGrid API Key is configured
  const apiKey = process.env.SENDGRID_API_KEY;
  if (!apiKey) {
    console.error('Configuration Error: SENDGRID_API_KEY environment variable is not defined.');
    return res.status(500).json({
      status: 'error',
      message: 'Internal Server Error. API service configuration is incomplete.'
    });
  }

  // Set the SendGrid API Key
  sgMail.setApiKey(apiKey);

  // Construct the email payload
  const emailPayload = {
    to: 'naveen.h760@gmail.com',         // Your verified destination inbox
    from: 'contact@naveenh.in',          // Your SendGrid verified sender identity
    replyTo: email.trim(),               // Directly reply to the client who filled the form!
    subject: `New Lead: ${subject.trim()}`,
    text: `You have received a new message from your website contact form.\n\n` +
          `----------------------------------------\n` +
          `Sender Details:\n` +
          `Name:  ${name.trim()}\n` +
          `Email: ${email.trim()}\n` +
          `----------------------------------------\n\n` +
          `Message:\n` +
          `${message.trim()}\n`
  };

  try {
    console.log(`Attempting to send contact email from ${email} regarding: ${subject}`);
    const [response] = await sgMail.send(emailPayload);
    
    if (response.statusCode >= 200 && response.statusCode < 300) {
      console.log('Contact form email successfully dispatched via SendGrid.');
      return res.status(200).json({
        status: 'success',
        message: 'Your message has been sent successfully!'
      });
    } else {
      throw new Error(`SendGrid responded with unexpected status code: ${response.statusCode}`);
    }
  } catch (error) {
    console.error('Failed to dispatch email through SendGrid API:', error);
    
    // Check if there are descriptive error details inside the SendGrid response payload
    const sendGridErrorDetails = error.response && error.response.body && error.response.body.errors;
    if (sendGridErrorDetails) {
      console.error('SendGrid API Error Details:', JSON.stringify(sendGridErrorDetails));
    }

    return res.status(500).json({
      status: 'error',
      message: 'Failed to send message. Please try again later.'
    });
  }
};
