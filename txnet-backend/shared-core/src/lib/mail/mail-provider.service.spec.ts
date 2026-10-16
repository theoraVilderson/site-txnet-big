import { createServer, type Server, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import {
  MAIL_ACCOUNT_REFUSED,
  MAIL_RECIPIENT_REFUSED,
  MAIL_TRANSPORT_FAILURE,
  MailProviderService,
} from './mail-provider.service';

/**
 * The driver against a real nodemailer transport, not a fake one: the three
 * failure kinds are read off nodemailer's own `code` / `responseCode`, and a
 * major bump (7 -> 10, SEC-1-a) is exactly where those could move unseen.
 * The server below speaks just enough SMTP to accept or refuse at one step.
 */
type Refusal = { at: 'AUTH' | 'RCPT'; reply: string } | null;

function smtpServer(refusal: Refusal): Server {
  return createServer((socket: Socket) => {
    const reply = (line: string) => socket.write(`${line}\r\n`);
    let inData = false;
    reply('220 test ESMTP');
    socket.on('data', (chunk) => {
      for (const line of chunk.toString().split('\r\n').filter(Boolean)) {
        if (inData) {
          if (line === '.') {
            inData = false;
            reply('250 queued');
          }
          continue;
        }
        const verb = line.split(' ')[0].toUpperCase();
        if (refusal && verb === refusal.at) reply(refusal.reply);
        else if (verb === 'EHLO') reply('250-test\r\n250 AUTH PLAIN');
        else if (verb === 'AUTH') reply('235 ok');
        else if (verb === 'DATA') {
          inData = true;
          reply('354 go');
        } else if (verb === 'QUIT') socket.end('221 bye\r\n');
        else reply('250 ok');
      }
    });
  });
}

async function send(refusal: Refusal, port?: number) {
  const server = smtpServer(refusal);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const mail = new MailProviderService({
      host: '127.0.0.1',
      port: port ?? (server.address() as AddressInfo).port,
      secure: false,
      user: 'relay',
      pass: 'secret',
      from: 'TXNet <no-reply@example.test>',
    });
    return await mail.sendMail({ to: 'person@example.test', subject: 'code', text: '123456' });
  } finally {
    server.close();
  }
}

describe('MailProviderService over SMTP', () => {
  it('reports a delivered message as ok', async () => {
    const result = await send(null);
    expect(result.ok).toBe(true);
  });

  it('names a refused recipient, which is not worth another try', async () => {
    const result = await send({ at: 'RCPT', reply: '550 no such user' });
    expect(result).toMatchObject({ ok: false, msg: MAIL_RECIPIENT_REFUSED });
  });

  it('names a refused account, which is not worth another try either', async () => {
    const result = await send({ at: 'AUTH', reply: '535 bad credentials' });
    expect(result).toMatchObject({ ok: false, msg: MAIL_ACCOUNT_REFUSED });
  });

  it('reads an unreachable server as the transport, which the queue retries', async () => {
    // Port 1 on loopback refuses the connection outright.
    const result = await send(null, 1);
    expect(result).toMatchObject({ ok: false, msg: MAIL_TRANSPORT_FAILURE });
  });
});
