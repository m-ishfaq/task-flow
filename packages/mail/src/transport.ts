import { createTransport, type Transporter } from 'nodemailer';
import type { RenderedMail } from './templates.js';

/**
 * How a message actually leaves the process.
 *
 * The interface exists so the queue above it can be tested without SMTP, and so
 * the deployed provider is a one-line swap. Everything security-relevant about
 * mail is in the templates and the queue; this layer only moves bytes.
 */

export interface OutboundMessage extends RenderedMail {
  readonly to: string;
}

export interface Mailer {
  send(message: OutboundMessage): Promise<void>;
  close(): Promise<void>;
}

export interface SmtpConfig {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly from: string;
  readonly user?: string;
  readonly password?: string;
}

/**
 * How long a single send may take.
 *
 * Bounded because the sender runs in the API process. An SMTP server that
 * accepts a connection and then stalls would otherwise hold a socket and a queue
 * slot indefinitely, and the visible symptom is "verification emails stopped
 * arriving" with nothing in the logs.
 */
const SEND_TIMEOUT_MS = 10_000;

export class SmtpMailer implements Mailer {
  readonly #transport: Transporter;
  readonly #from: string;

  constructor(config: SmtpConfig) {
    this.#from = config.from;
    this.#transport = createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      connectionTimeout: SEND_TIMEOUT_MS,
      greetingTimeout: SEND_TIMEOUT_MS,
      socketTimeout: SEND_TIMEOUT_MS,
      /* Only when credentials are configured. Mailpit accepts anything, and
         passing `auth: { user: undefined }` makes nodemailer attempt AUTH with
         an empty user, which real servers reject. */
      ...(config.user === undefined || config.password === undefined
        ? {}
        : { auth: { user: config.user, pass: config.password } }),
    });
  }

  async send(message: OutboundMessage): Promise<void> {
    await this.#transport.sendMail({
      from: this.#from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
  }

  async close(): Promise<void> {
    this.#transport.close();
    return Promise.resolve();
  }
}

/** Collects messages in memory. For tests and for `--dry-run` style local work. */
export class MemoryMailer implements Mailer {
  readonly sent: OutboundMessage[] = [];
  #failNext = 0;

  /** Makes the next `n` sends throw, so retry behaviour can be exercised. */
  failNext(count: number): void {
    this.#failNext = count;
  }

  send(message: OutboundMessage): Promise<void> {
    if (this.#failNext > 0) {
      this.#failNext -= 1;
      return Promise.reject(new Error('simulated transport failure'));
    }
    this.sent.push(message);
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}
