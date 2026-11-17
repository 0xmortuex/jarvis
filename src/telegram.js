// The listening half of Telegram: long-poll the bot for messages, hand each one to
// the chat brain, send the answer back.
//
// Rules this file keeps:
//   * Only the one configured chat is obeyed. A bot's name is public, so anyone can
//     write to it; a message from any other chat is dropped without a reply.
//   * The bot token comes from the environment and is never put in an error or a log
//     (the request URL contains it, so the URL is never reported either).
//   * A message is marked as seen BEFORE it is handled. A crash must not replay a command.
import path from 'node:path';
import { JsonStore } from './store.js';

const MAX_TEXT = 4000;
const LONG_POLL_SECONDS = 50;

/** A tiny client for the two Bot API calls Jarvis needs. `fetch` is injected. */
export function createTelegramApi({ env, fetch }) {
  async function call(method, body, { timeoutMs, signal } = {}) {
    const token = env.TELEGRAM_BOT_TOKEN;
    if (!token) throw Object.assign(new Error('Telegram needs TELEGRAM_BOT_TOKEN in the environment'), { fatal: true });

    const timer = new AbortController();
    const t = setTimeout(() => timer.abort(), timeoutMs);
    const onStop = () => timer.abort();
    signal?.addEventListener('abort', onStop, { once: true });
    let res;
    try {
      res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: timer.signal,
      });
    } catch (err) {
      // Deliberately not err.message: a fetch error can quote the URL, and the URL holds the token.
      throw new Error(`telegram ${method} could not be reached (${err.cause?.code || err.name || 'network error'})`);
    } finally {
      clearTimeout(t);
      signal?.removeEventListener('abort', onStop);
    }

    if (!res.ok) {
      // 401 and 404 mean the token is wrong; trying again cannot help.
      throw Object.assign(new Error(`telegram ${method} answered ${res.status}`), { status: res.status, fatal: res.status === 401 || res.status === 404 });
    }
    const data = await res.json();
    if (!data || data.ok !== true) throw new Error(`telegram ${method} did not succeed`);
    return data.result;
  }

  return {
    /** Waits up to `timeoutSec` for new messages. `offset` is the first update id not yet seen. */
    getUpdates({ offset, timeoutSec = LONG_POLL_SECONDS, signal } = {}) {
      return call('getUpdates', { offset, timeout: timeoutSec, allowed_updates: ['message'] }, { timeoutMs: (timeoutSec + 15) * 1000, signal });
    },
    sendMessage(chatId, text) {
      const body = String(text ?? '');
      return call('sendMessage', { chat_id: chatId, text: body.length > MAX_TEXT ? `${body.slice(0, MAX_TEXT - 1)}…` : body, disable_web_page_preview: true }, { timeoutMs: 20000 });
    },
  };
}

export class TelegramListener {
  /**
   * @param {object} o
   * @param {object} o.api        from createTelegramApi
   * @param {string|number} o.chatId   the only chat that is obeyed
   * @param {object} o.chat       from createChat: { reply(text, { conversation }) }
   * @param {string} o.dir        the Jarvis home; the read position is kept here
   * @param {Function} [o.onProblem] async (message, { stopped }) => void, called when listening fails
   */
  constructor({ api, chatId, chat, dir, logger = () => {}, onProblem = async () => {}, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
    if (chatId === undefined || chatId === null || chatId === '') throw new Error('The telegram listener needs a chatId');
    this.api = api;
    this.chatId = String(chatId);
    this.chat = chat;
    this.log = logger;
    this.onProblem = onProblem;
    this.sleep = sleep;
    this.state = new JsonStore(path.join(dir, 'telegram.json'), { offset: 0 });
    this.running = false;
    this.stopper = null;
  }

  /** Fetch waiting messages once and answer them. Returns how many updates were seen. */
  async pollOnce({ timeoutSec, signal } = {}) {
    const { offset } = this.state.read();
    const updates = await this.api.getUpdates({ offset, timeoutSec, signal });
    for (const update of updates) {
      this.state.write({ offset: update.update_id + 1 });
      const msg = update.message;
      if (!msg) continue;
      if (String(msg.chat?.id) !== this.chatId) {
        this.log('telegram: ignored a message from a chat that is not the configured one');
        continue;
      }
      if (typeof msg.text !== 'string') {
        await this.api.sendMessage(this.chatId, 'I can only read text messages.');
        continue;
      }
      const answer = await this.chat.reply(msg.text, { conversation: `telegram:${this.chatId}` });
      await this.api.sendMessage(this.chatId, answer);
    }
    return updates.length;
  }

  /** Keep polling until stop(). Failures are reported and retried with a growing pause; a bad token stops it. */
  start() {
    if (this.running) return this.done;
    this.running = true;
    this.stopper = new AbortController();
    this.done = this._run();
    return this.done;
  }

  async _run() {
    let pause = 0;
    while (this.running) {
      try {
        await this.pollOnce({ signal: this.stopper.signal });
        pause = 0;
      } catch (err) {
        if (!this.running) break;
        this.log(`telegram listener: ${err.message}`);
        if (err.fatal) {
          this.running = false;
          await this.onProblem(err.message, { stopped: true });
          break;
        }
        await this.onProblem(err.message, { stopped: false });
        pause = Math.min(60000, pause ? pause * 2 : 5000);
        await this.sleep(pause);
      }
    }
  }

  stop() {
    this.running = false;
    this.stopper?.abort();
  }
}
