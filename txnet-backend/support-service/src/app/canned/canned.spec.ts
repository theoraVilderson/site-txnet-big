import { Language } from '@prisma/client';

import { CANNED_VARIABLES, renderCanned, textIn, unknownVariables } from './canned';

/**
 * Canned replies (F-033-j, catalog §11.3): a text per language with
 * `{variable}`s filled when an agent inserts one.
 *
 * What breaks silently here: a typo'd variable saved and sent to a user as
 * `{user.nmae}`, a value that itself looks like a variable being expanded a
 * second time (a user named "{agent.name}"), and a reply shown in the agent's
 * language instead of the user's.
 */

const values = {
  'user.name': 'Sara',
  'agent.name': 'Kaveh',
  'tenant.name': 'FastVPN',
  'conversation.subject': 'No connection',
};

describe('canned replies (F-033-j)', () => {
  it('names exactly the four variables', () => {
    expect([...CANNED_VARIABLES]).toEqual(['user.name', 'agent.name', 'tenant.name', 'conversation.subject']);
  });

  it('fills every variable, as often as it appears', () => {
    expect(renderCanned('Hi {user.name}, {agent.name} from {tenant.name} here about "{conversation.subject}". Bye {user.name}', values)).toBe(
      'Hi Sara, Kaveh from FastVPN here about "No connection". Bye Sara',
    );
  });

  it('never expands a value a second time', () => {
    expect(renderCanned('Hi {user.name}', { ...values, 'user.name': '{agent.name}' })).toBe('Hi {agent.name}');
  });

  it('names the variables it does not know, so a typo is refused when it is saved', () => {
    expect(unknownVariables('Hi {user.nmae}, see {tenant.name} and {foo.bar}')).toEqual(['user.nmae', 'foo.bar']);
    expect(unknownVariables('Plain {text} and {user.name}')).toEqual([]);
  });

  it("picks the reader's language, else the reference language, else any", () => {
    const texts = [
      { lang: Language.en, body: 'Hello' },
      { lang: Language.fa, body: 'سلام' },
    ];
    expect(textIn(texts, 'en')).toBe('Hello');
    expect(textIn(texts, 'fa')).toBe('سلام');
    expect(textIn(texts, 'de')).toBe('سلام');
    expect(textIn([{ lang: Language.en, body: 'Hello' }], 'fa')).toBe('Hello');
    expect(textIn([], 'fa')).toBeUndefined();
  });
});
