import { OtpPurpose } from '../otp.interface';
import {
  buildOtpChatMessage,
  buildOtpSmsTemplate,
  type OtpNamespace,
} from './otp-message.util';

/**
 * The fallbacks are the point of this module. A missing translation must
 * degrade to English text, never to an empty message or a raw `{{title}}` —
 * a user who receives a blank SMS has no code and no way to ask for a better
 * one, and a translation gap is exactly the kind of thing that shows up on the
 * day a language is added.
 *
 * The other half is the division of labour with the SMS provider: the chat
 * builder substitutes the code, the SMS builder deliberately does not.
 */

const CODE = '987654';

describe('buildOtpChatMessage', () => {
  it('uses the locale title and body when both are present', () => {
    const ns: OtpNamespace = {
      otp: {
        title: { [OtpPurpose.login]: 'کد ورود شما' },
        chatBody: '{{title}}\n{{code}}',
      },
    };

    expect(buildOtpChatMessage(ns, CODE, OtpPurpose.login)).toBe('کد ورود شما\n987654');
  });

  it('falls back to English when the namespace is missing entirely', () => {
    const text = buildOtpChatMessage(undefined, CODE, OtpPurpose.login);

    expect(text).toContain('Your login code');
    expect(text).toContain(CODE);
    expect(text).not.toContain('{{');
  });

  it('falls back per field, not all-or-nothing', () => {
    // A locale that translated the body but not this purpose's title still
    // gets its body; the title alone falls back.
    const ns: OtpNamespace = { otp: { chatBody: '[{{title}}] {{code}}' } };

    expect(buildOtpChatMessage(ns, CODE, OtpPurpose.password_reset)).toBe(
      '[Your password reset code] 987654',
    );
  });

  it('has a fallback title for every purpose', () => {
    // A purpose added to the enum without a fallback would send a message
    // titled "undefined" in any language that has not translated it yet.
    for (const purpose of Object.values(OtpPurpose)) {
      const text = buildOtpChatMessage(undefined, CODE, purpose);
      expect(text).not.toContain('undefined');
      expect(text).toContain(CODE);
    }
  });

  it('tolerates whitespace inside the placeholders', () => {
    const ns: OtpNamespace = { otp: { chatBody: '{{ title }} — {{  code  }}' } };

    expect(buildOtpChatMessage(ns, CODE, OtpPurpose.login)).toBe(
      'Your login code — 987654',
    );
  });

  it('replaces every occurrence of a placeholder', () => {
    const ns: OtpNamespace = { otp: { chatBody: '{{code}} / {{code}}' } };

    expect(buildOtpChatMessage(ns, CODE, OtpPurpose.login)).toBe('987654 / 987654');
  });

  it('leaves a template with no placeholders alone', () => {
    const ns: OtpNamespace = { otp: { chatBody: 'A code was requested.' } };

    expect(buildOtpChatMessage(ns, CODE, OtpPurpose.login)).toBe('A code was requested.');
  });

  it('survives a half-built namespace', () => {
    // getNamespace returns whatever locale-service has; an empty object and a
    // present-but-empty `otp` are both real states.
    for (const ns of [{}, { otp: {} }, { otp: { title: {} } }] as OtpNamespace[]) {
      expect(buildOtpChatMessage(ns, CODE, OtpPurpose.login)).toContain(CODE);
    }
  });
});

describe('buildOtpSmsTemplate', () => {
  it('resolves the title but leaves {{code}} for the provider', () => {
    // SmsProviderService.sendSMS substitutes `vars` itself. Substituting here
    // too would mean the code is interpolated twice — or, worse, that a
    // change to either side silently starts sending the literal "{{code}}".
    const template = buildOtpSmsTemplate(undefined, OtpPurpose.login);

    expect(template).toContain('Your login code');
    expect(template).toContain('{{code}}');
  });

  it('uses the locale SMS body when present', () => {
    const ns: OtpNamespace = {
      otp: { title: { [OtpPurpose.login]: 'کد ورود' }, smsBody: '{{title}}: {{code}}' },
    };

    expect(buildOtpSmsTemplate(ns, OtpPurpose.login)).toBe('کد ورود: {{code}}');
  });

  it('keeps {{code}} even when the locale body is written without it', () => {
    // Nothing can be done about a translator dropping the placeholder — but
    // the builder must not be the one that drops it.
    const ns: OtpNamespace = { otp: { smsBody: '{{title}}' } };

    expect(buildOtpSmsTemplate(ns, OtpPurpose.login)).toBe('Your login code');
  });

  it('has a fallback for every purpose', () => {
    for (const purpose of Object.values(OtpPurpose)) {
      const template = buildOtpSmsTemplate(undefined, purpose);
      expect(template).not.toContain('undefined');
      expect(template).toContain('{{code}}');
    }
  });
});
