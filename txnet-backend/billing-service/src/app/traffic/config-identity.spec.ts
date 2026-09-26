/**
 * A pasted config line, reduced to what says which config it is (F-307-p).
 *
 * The name is the part that fails silently: the buyer renames a config
 * (F-307-g), a reseller changes its template (F-307-j), and every line the
 * buyer holds now carries a name the stored line does not. So the name is
 * never part of the identity — the uuid where the line carries one, else the
 * line without its `#name`.
 */
import { configIdentityOf, storedLineIdentity } from './config-identity';

const UUID = 'b831381d-6324-4d53-ad4f-8cda48b30811';

const vmess = (obj: Record<string, unknown>) => `vmess://${Buffer.from(JSON.stringify(obj), 'utf8').toString('base64')}`;

describe('configIdentityOf', () => {
  it('answers the uuid a vless, trojan or vmess line carries, lowercased, whatever it is named', () => {
    expect(configIdentityOf(`vless://${UUID}@de1.example.com:443?security=reality#Ali%20home`)).toEqual({ uuid: UUID });
    expect(configIdentityOf(`trojan://${UUID.toUpperCase()}@de1.example.com:443#x`)).toEqual({ uuid: UUID });
    expect(configIdentityOf(vmess({ v: '2', ps: 'Germany', add: 'de1.example.com', id: UUID }))).toEqual({ uuid: UUID });
  });

  it('answers the line without its name when there is no uuid to read', () => {
    expect(configIdentityOf('ss://YWVzLTI1Ni1nY206cGFzcw@de1.example.com:8388#Germany')).toEqual({
      line: 'ss://YWVzLTI1Ni1nY206cGFzcw@de1.example.com:8388',
    });
    // A trojan password that is not a uuid is not guessed at: the line is compared instead.
    expect(configIdentityOf('trojan://hunter2@de1.example.com:443#x')).toEqual({ line: 'trojan://hunter2@de1.example.com:443' });
  });

  it('trims the line and answers nothing for a blank one', () => {
    expect(configIdentityOf(`  vless://${UUID}@h:1#n \r`)).toEqual({ uuid: UUID });
    expect(configIdentityOf('   ')).toBeNull();
  });

  it('reads a vmess line with no parsable payload as a line, never throws', () => {
    expect(configIdentityOf('vmess://not-base64!')).toEqual({ line: 'vmess://not-base64!' });
  });
});

describe('storedLineIdentity', () => {
  it('is what a pasted copy of the same line reduces to, however either was named', () => {
    const stored = 'ss://YWVzLTI1Ni1nY206cGFzcw@de1.example.com:8388#panel-name';
    expect(storedLineIdentity(stored)).toBe((configIdentityOf('ss://YWVzLTI1Ni1nY206cGFzcw@de1.example.com:8388#Ali') as { line: string }).line);
  });
});
