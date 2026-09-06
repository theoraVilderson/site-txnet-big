import axios from 'axios';
import { replaceVar } from './helper';
import { SmsProviderService } from './sms-provider.service';

jest.mock('axios');

/**
 * The provider is the only third-party call in the OTP path, and it is one
 * that reports failure in its body rather than its status: the gateway answers
 * 200 with the string `SendWasSuccessful`, or 200 with an error string. A
 * client that trusted the status code would report every rejected number as a
 * code that was sent, and the user would wait for an SMS that was refused.
 */

const mockedAxios = axios as jest.Mocked<typeof axios>;

function provider(apiKey = 'user@pass') {
  const get = jest.fn();
  mockedAxios.create.mockReturnValue({ get } as never);
  return { service: new SmsProviderService('https://sms.example', apiKey), get };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('replaceVar', () => {
  it('substitutes every occurrence, with or without inner whitespace', () => {
    expect(replaceVar('{{code}} {{ code }} {{code}}', { code: '1' })).toBe('1 1 1');
  });

  it('stringifies a numeric value', () => {
    expect(replaceVar('code {{code}}', { code: 123456 })).toBe('code 123456');
  });

  it('leaves an unsupplied placeholder in place rather than blanking it', () => {
    expect(replaceVar('{{title}}: {{code}}', { code: '1' })).toBe('{{title}}: 1');
  });

  it('returns the template unchanged when there is nothing to substitute', () => {
    expect(replaceVar('no placeholders', { code: '1' })).toBe('no placeholders');
  });
});

describe('SmsProviderService', () => {
  it('splits the api key into the username and password the gateway wants', async () => {
    const { service, get } = provider('smsuser@s3cret');
    get.mockResolvedValue({ data: 'SendWasSuccessful' });

    await service.sendSMS({ msg: 'hi', to: '09121112233' }, '3000');

    expect(get).toHaveBeenCalledWith('/SendSms', {
      params: {
        UserName: 'smsuser',
        Password: 's3cret',
        From: '3000',
        To: '09121112233',
        Message: 'hi',
      },
    });
  });

  it('substitutes the code into the template before sending', async () => {
    const { service, get } = provider();
    get.mockResolvedValue({ data: 'SendWasSuccessful' });

    await service.sendSMS(
      { msg: 'Your code: {{code}}', to: '09121112233', vars: { code: '123456' } },
      '3000',
    );

    expect(get.mock.calls[0][1].params.Message).toBe('Your code: 123456');
  });

  it('reports success only for the gateway’s exact success string', async () => {
    const { service, get } = provider();
    get.mockResolvedValue({ data: 'SendWasSuccessful' });

    await expect(service.sendSMS({ msg: 'hi', to: '1' }, '3000')).resolves.toMatchObject({
      ok: true,
    });
  });

  it('reads a 200 with an error body as a failure', async () => {
    // This is the case a status-code check would miss entirely.
    const { service, get } = provider();
    get.mockResolvedValue({ data: 'InvalidReceiverNumber' });

    await expect(service.sendSMS({ msg: 'hi', to: 'bad' }, '3000')).resolves.toMatchObject({
      ok: false,
      msg: 'InvalidReceiverNumber',
    });
  });

  it.each([
    ['a near-miss string', 'sendwassuccessful'],
    ['an empty body', ''],
    ['a null body', null],
    ['an unexpected shape', { status: 'ok' }],
  ])('does not read %s as success', async (_name, data) => {
    const { service, get } = provider();
    get.mockResolvedValue({ data });

    await expect(service.sendSMS({ msg: 'hi', to: '1' }, '3000')).resolves.toMatchObject({
      ok: false,
    });
  });

  it('turns a transport failure into a failed result rather than throwing', async () => {
    // The caller (SmsOtpSender) branches on `ok`; a thrown error here would
    // escape as a 500 instead of the otp.smsSendFailed business error.
    const { service, get } = provider();
    get.mockRejectedValue(new Error('ETIMEDOUT'));

    await expect(service.sendSMS({ msg: 'hi', to: '1' }, '3000')).resolves.toMatchObject({
      ok: false,
      msg: 'SMS failed to sent',
    });
  });

  it('sends nothing at all when force is false', async () => {
    // The development escape hatch: it must not reach the gateway, and it
    // must still answer in the success shape callers expect.
    const { service, get } = provider();

    const result = await service.sendSMS({ msg: 'hi', to: '1' }, '3000', false);

    expect(result.ok).toBe(true);
    expect(get).not.toHaveBeenCalled();
  });

  it('sends the template untouched when there are no vars', async () => {
    const { service, get } = provider();
    get.mockResolvedValue({ data: 'SendWasSuccessful' });

    await service.sendSMS({ msg: 'Your code: {{code}}', to: '1' }, '3000');

    expect(get.mock.calls[0][1].params.Message).toBe('Your code: {{code}}');
  });
});
