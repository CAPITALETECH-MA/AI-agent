import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

// ES module compatible __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Path to your OAuth2 credentials and token (use env var if set, otherwise fall back to project root via process.cwd())
const CREDENTIALS_PATH = process.env.GMAIL_CREDENTIALS_PATH || path.join(process.cwd(), 'gmail-credentials.json');
const TOKEN_PATH = process.env.GMAIL_TOKEN_PATH || path.join(process.cwd(), 'gmail-token.json');
console.error('Gmail credentials path resolved to:', CREDENTIALS_PATH);
console.error('Gmail token path resolved to:', TOKEN_PATH);

// Scopes required for sending email
const SCOPES = ['https://www.googleapis.com/auth/gmail.send'];

/**
 * Loads OAuth2 credentials from file
 */
function loadCredentials() {
  return JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf-8'));
}

/**
 * Loads or requests OAuth2 token
 */
async function getOAuth2Client(): Promise<any> {
  const { client_secret, client_id, redirect_uris } = loadCredentials().installed || loadCredentials().web;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

  // Try to load token
  if (fs.existsSync(TOKEN_PATH)) {
    const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf-8'));
    oAuth2Client.setCredentials(token);
    return oAuth2Client;
  }

  // If no token, get new one
  const authUrl = oAuth2Client.generateAuthUrl({ access_type: 'offline', scope: SCOPES });
  console.log('Authorize this app by visiting this url:', authUrl);
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const code: string = await new Promise(resolve => rl.question('Enter the code from that page here: ', resolve));
  rl.close();
  const { tokens } = await oAuth2Client.getToken(code);
  oAuth2Client.setCredentials(tokens);
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens));
  console.log('Token stored to', TOKEN_PATH);
  return oAuth2Client;
}

/**
 * Sends an email using Gmail API and OAuth2.
 * @param to - Recipient email address
 * @param subject - Email subject
 * @param body - Email body (plain text)
 */
export async function sendEmailWithGmailAPI(to: string, subject: string, body: string): Promise<void> {
  const auth = await getOAuth2Client();
  const gmail = google.gmail({ version: 'v1', auth });

  // Create the email
  const email = [
    `To: ${to}`,
    'Content-Type: text/plain; charset=utf-8',
    'MIME-Version: 1.0',
    `Subject: ${subject}`,
    '',
    body,
  ].join('\n');

  const encodedMessage = Buffer.from(email).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw: encodedMessage },
  });
}

// Mastra tool definition for use in agents and workflows
export const sendEmailTool = createTool({
  id: 'send-email',
  description: 'Sends an email using the Gmail API. Provide recipient email, subject, and body.',
  inputSchema: z.object({
    to: z.string().email().describe('Recipient email address'),
    subject: z.string().describe('Email subject'),
    body: z.string().describe('Email body (plain text)'),
  }),
  execute: async (context) => {
    console.error('TEST LOG - Gmail tool execute called');
    console.log('Gmail tool context:', context);
    // Support Playground/agent direct calls: check input, args, or direct context fields
    const input = context.input || context.args || context.context || context || {};
    const { to, subject, body } = input;
    if (!to || !subject || !body) {
      console.error('Input extraction failed. Input object:', input);
      throw new Error("Missing required input fields: to, subject, body");
    }
    try {
      await sendEmailWithGmailAPI(to, subject, body);
      return { success: true };
    } catch (err) {
      // Log the error for debugging
      console.error('Gmail API error:', err);
      // Return a more detailed error to the agent/user
      throw new Error(`Failed to send email: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
});
