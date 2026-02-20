import 'dotenv/config';
import input from 'input';
import OpenAI from 'openai';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage } from 'telegram/events/index.js';

const TELEGRAM_API_ID = Number(process.env.TELEGRAM_API_ID);
const TELEGRAM_API_HASH = process.env.TELEGRAM_API_HASH;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!TELEGRAM_API_ID || !TELEGRAM_API_HASH || !OPENAI_API_KEY) {
  console.error(
    '❌ Missing environment variables. Please set TELEGRAM_API_ID, TELEGRAM_API_HASH, OPENAI_API_KEY in .env'
  );
  process.exit(1);
}

const stringSession = new StringSession('');
const telegramClient = new TelegramClient(stringSession, TELEGRAM_API_ID, TELEGRAM_API_HASH, {
  connectionRetries: 5,
});

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

const REPLY_SUFFIX = 'Bu men emasman, AI. Hozir bandman.';
const MIN_REPLY_DELAY_MS = 2000;
const MAX_REPLY_DELAY_MS = 5000;
const USER_COOLDOWN_MS = 10_000;

let autoReplyEnabled = true;
const ignoredUsernames = ['spam_user_1', 'example_ignore'];
const lastReplyByUser = new Map();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const randomDelay = () =>
  Math.floor(Math.random() * (MAX_REPLY_DELAY_MS - MIN_REPLY_DELAY_MS + 1)) + MIN_REPLY_DELAY_MS;

function log(message) {
  const now = new Date().toISOString();
  console.log(`[${now}] ${message}`);
}

function isBlacklisted(username) {
  return username ? ignoredUsernames.includes(username.toLowerCase()) : false;
}

function canReply(userId) {
  const now = Date.now();
  const lastReply = lastReplyByUser.get(userId) || 0;
  return now - lastReply >= USER_COOLDOWN_MS;
}

function markReplied(userId) {
  lastReplyByUser.set(userId, Date.now());
}

async function generateAiReply(messageText) {
  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content:
          'You are writing short, friendly, natural replies to Telegram private messages. Respond like a real human, never robotic, and keep it concise.',
      },
      {
        role: 'user',
        content: messageText,
      },
    ],
    temperature: 0.8,
  });

  const aiText = completion.choices?.[0]?.message?.content?.trim() || 'Kechirasiz, keyinroq yozaman.';
  return `${aiText}\n\n${REPLY_SUFFIX}`;
}

async function handlePrivateMessage(event) {
  const message = event.message;

  if (!message || !message.isPrivate) return;
  if (message.out) return;

  const sender = await message.getSender();
  if (!sender || sender.bot) return;

  const senderId = sender.id?.toString();
  const username = (sender.username || '').toLowerCase();

  if (isBlacklisted(username)) {
    log(`⏭ Ignored blacklisted user: @${username || 'unknown'} (${senderId})`);
    return;
  }

  const text = message.message?.trim();
  if (!text) {
    log(`⏭ Ignored empty message from ${senderId}`);
    return;
  }

  if (text === '/on') {
    autoReplyEnabled = true;
    await telegramClient.sendMessage(message.peerId, { message: '✅ Auto-reply is ON.' });
    log(`✅ Auto-reply enabled by user ${senderId}`);
    return;
  }

  if (text === '/off') {
    autoReplyEnabled = false;
    await telegramClient.sendMessage(message.peerId, { message: '⛔ Auto-reply is OFF.' });
    log(`⛔ Auto-reply disabled by user ${senderId}`);
    return;
  }

  if (!autoReplyEnabled) {
    log(`⏸ Auto-reply disabled. Skipped message from ${senderId}`);
    return;
  }

  if (!canReply(senderId)) {
    log(`🚫 Cooldown active for user ${senderId}. Reply skipped.`);
    return;
  }

  try {
    const delay = randomDelay();
    log(`📩 Incoming from ${senderId}${username ? ` (@${username})` : ''}: ${text}`);
    log(`⏳ Waiting ${delay}ms before reply...`);
    await sleep(delay);

    const reply = await generateAiReply(text);
    await telegramClient.sendMessage(message.peerId, { message: reply });
    markReplied(senderId);

    log(`✅ Replied to ${senderId}`);
  } catch (error) {
    log(`❌ Failed to reply to ${senderId}: ${error?.message || error}`);
  }
}

async function startUserbot() {
  log('🚀 Starting Telegram userbot...');

  await telegramClient.start({
    phoneNumber: async () => input.text('Enter your phone number (with country code): '),
    password: async () => input.text('Enter your 2FA password (if enabled): '),
    phoneCode: async () => input.text('Enter the login code from Telegram: '),
    onError: (error) => log(`Telegram login error: ${error}`),
  });

  const me = await telegramClient.getMe();
  log(`✅ Logged in as ${me?.username || me?.firstName || me?.id}`);
  log('💾 Save this session string if you want faster login next time:');
  log(telegramClient.session.save());

  telegramClient.addEventHandler(handlePrivateMessage, new NewMessage({ incoming: true }));
  log('🤖 Userbot is running. Listening for private messages...');
}

startUserbot().catch((error) => {
  log(`Fatal error: ${error?.message || error}`);
  process.exit(1);
});
