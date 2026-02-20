import 'dotenv/config';
import input from 'input';
import { GoogleGenerativeAI } from '@google/generative-ai';
import TelegramBot from 'node-telegram-bot-api';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage } from 'telegram/events/index.js';

const TELEGRAM_API_ID = Number(process.env.TELEGRAM_API_ID);
const TELEGRAM_API_HASH = process.env.TELEGRAM_API_HASH;
const TELEGRAM_SESSION = process.env.TELEGRAM_SESSION || '';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const TELEGRAM_PHONE = process.env.TELEGRAM_PHONE || '';
const TELEGRAM_LOGIN_CODE = process.env.TELEGRAM_LOGIN_CODE || '';
const TELEGRAM_2FA_PASSWORD = process.env.TELEGRAM_2FA_PASSWORD || '';

const CONTROL_BOT_TOKEN = process.env.CONTROL_BOT_TOKEN || '';
const CONTROL_BOT_OWNER_ID = process.env.CONTROL_BOT_OWNER_ID || '';

if (!TELEGRAM_API_ID || !TELEGRAM_API_HASH || !GEMINI_API_KEY) {
  console.error(
    '❌ Missing TELEGRAM_API_ID, TELEGRAM_API_HASH, or GEMINI_API_KEY in .env'
  );
  process.exit(1);
}

const userbotClient = new TelegramClient(
  new StringSession(TELEGRAM_SESSION),
  TELEGRAM_API_ID,
  TELEGRAM_API_HASH,
  { connectionRetries: 5 }
);

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const geminiModel = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

const REPLY_SUFFIX = 'Bu men emasman, AI. Hozir bandman.';
const MIN_REPLY_DELAY_MS = 2000;
const MAX_REPLY_DELAY_MS = 5000;
const USER_COOLDOWN_MS = 10_000;

let autoReplyEnabled = true;
const ignoredUsernames = new Set(['spam_user_1', 'example_ignore']);
const lastReplyByUser = new Map();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const randomDelay = () =>
  Math.floor(Math.random() * (MAX_REPLY_DELAY_MS - MIN_REPLY_DELAY_MS + 1)) + MIN_REPLY_DELAY_MS;

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function isBlacklisted(username) {
  return username ? ignoredUsernames.has(username.toLowerCase()) : false;
}

function canReply(userId) {
  const now = Date.now();
  const lastReply = lastReplyByUser.get(userId) || 0;
  return now - lastReply >= USER_COOLDOWN_MS;
}

function markReplied(userId) {
  lastReplyByUser.set(userId, Date.now());
}

async function getPhoneNumber() {
  if (TELEGRAM_PHONE) {
    log('📱 Using TELEGRAM_PHONE from .env');
    return TELEGRAM_PHONE;
  }
  return input.text('Enter your phone number (with country code): ');
}

async function getLoginCode() {
  if (TELEGRAM_LOGIN_CODE) {
    log('🔢 Using TELEGRAM_LOGIN_CODE from .env');
    return TELEGRAM_LOGIN_CODE;
  }
  return input.text('Enter the login code from Telegram: ');
}

async function getPassword() {
  if (TELEGRAM_2FA_PASSWORD) {
    log('🔐 Using TELEGRAM_2FA_PASSWORD from .env');
    return TELEGRAM_2FA_PASSWORD;
  }
  return input.text('Enter your 2FA password (if enabled): ');
}

async function generateAiReply(messageText) {
  const prompt = [
    'You are writing short, friendly, natural replies to Telegram private messages.',
    'Reply like a real human, never robotic, and keep it concise.',
    '',
    `Incoming message: ${messageText}`,
  ].join('\n');

  const result = await geminiModel.generateContent(prompt);
  const aiText = result.response.text()?.trim() || 'Kechirasiz, keyinroq yozaman.';
  return `${aiText}\n\n${REPLY_SUFFIX}`;
}

async function handlePrivateMessage(event) {
  const message = event.message;
  if (!message || !message.isPrivate || message.out) return;

  const sender = await message.getSender();
  if (!sender || sender.bot) return;

  const senderId = sender.id?.toString();
  const username = (sender.username || '').toLowerCase();
  const text = message.message?.trim();

  if (!text) {
    log(`⏭ Ignored empty message from ${senderId}`);
    return;
  }

  if (isBlacklisted(username)) {
    log(`⏭ Ignored blacklisted user: @${username || 'unknown'} (${senderId})`);
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
    await userbotClient.sendMessage(message.peerId, { message: reply });
    markReplied(senderId);

    log(`✅ Replied to ${senderId}`);
  } catch (error) {
    log(`❌ Failed to reply to ${senderId}: ${error?.message || error}`);
  }
}

function setupControlBot() {
  if (!CONTROL_BOT_TOKEN) {
    log('ℹ️ CONTROL_BOT_TOKEN not set. Control bot is disabled.');
    return;
  }

  if (!CONTROL_BOT_OWNER_ID) {
    log('⚠️ CONTROL_BOT_OWNER_ID is empty. Set it so only you can control the userbot.');
  }

  const controlBot = new TelegramBot(CONTROL_BOT_TOKEN, { polling: true });

  const isOwner = (msg) =>
    CONTROL_BOT_OWNER_ID ? String(msg.from?.id || '') === String(CONTROL_BOT_OWNER_ID) : true;

  controlBot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = (msg.text || '').trim();
    if (!text.startsWith('/')) return;

    if (!isOwner(msg)) {
      await controlBot.sendMessage(chatId, '⛔ Sizda ruxsat yo‘q.');
      log(`🚫 Unauthorized control attempt by ${msg.from?.id}`);
      return;
    }

    const [command, argRaw = ''] = text.split(' ');
    const arg = argRaw.replace('@', '').toLowerCase();

    if (command === '/on') {
      autoReplyEnabled = true;
      await controlBot.sendMessage(chatId, '✅ Auto-reply yoqildi.');
      return;
    }

    if (command === '/off') {
      autoReplyEnabled = false;
      await controlBot.sendMessage(chatId, '⛔ Auto-reply o‘chirildi.');
      return;
    }

    if (command === '/status') {
      await controlBot.sendMessage(
        chatId,
        `🤖 Auto-reply: ${autoReplyEnabled ? 'ON' : 'OFF'}\n🚫 Blacklist: ${
          [...ignoredUsernames].join(', ') || 'empty'
        }`
      );
      return;
    }

    if (command === '/ignore') {
      if (!arg) {
        await controlBot.sendMessage(chatId, 'Usage: /ignore username');
        return;
      }
      ignoredUsernames.add(arg);
      await controlBot.sendMessage(chatId, `✅ @${arg} blacklistga qo‘shildi.`);
      return;
    }

    if (command === '/unignore') {
      if (!arg) {
        await controlBot.sendMessage(chatId, 'Usage: /unignore username');
        return;
      }
      ignoredUsernames.delete(arg);
      await controlBot.sendMessage(chatId, `✅ @${arg} blacklistdan olindi.`);
      return;
    }

    if (command === '/help' || command === '/start') {
      await controlBot.sendMessage(
        chatId,
        [
          'Control commands:',
          '/on - auto-reply yoqish',
          '/off - auto-reply o‘chirish',
          '/status - holat ko‘rish',
          '/ignore username - blacklistga qo‘shish',
          '/unignore username - blacklistdan olish',
        ].join('\n')
      );
      return;
    }
  });

  log('🎛 Control bot is running. Use it to manage /on /off /status /ignore /unignore');
}

async function startUserbot() {
  log('🚀 Starting Telegram userbot...');

  if (TELEGRAM_SESSION) {
    log('🔐 Existing TELEGRAM_SESSION detected. Trying fast login...');
  } else {
    log('ℹ️ First-time login: enter phone number, Telegram code, and 2FA password if enabled.');
  }

  await userbotClient.start({
    phoneNumber: getPhoneNumber,
    password: getPassword,
    phoneCode: getLoginCode,
    onError: (error) => log(`Telegram login error: ${error}`),
  });

  const me = await userbotClient.getMe();
  log(`✅ Logged in as ${me?.username || me?.firstName || me?.id}`);

  if (!TELEGRAM_SESSION) {
    log('💾 Save session to .env as TELEGRAM_SESSION=... for next runs.');
    log('👉 To view once, set SHOW_SESSION_ON_LOGIN=true');
  }

  if (process.env.SHOW_SESSION_ON_LOGIN === 'true') {
    log('TELEGRAM_SESSION:');
    log(userbotClient.session.save());
  }

  userbotClient.addEventHandler(handlePrivateMessage, new NewMessage({ incoming: true }));
  log('🤖 Userbot is running. Listening for private messages...');

  setupControlBot();
}

startUserbot().catch((error) => {
  log(`Fatal error: ${error?.message || error}`);
  process.exit(1);
});
