import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { OutboxEventType } from './routing-keys';

/**
 * `OutboxEventType` is also the `type` of the realtime event the panel reads,
 * and the panel cannot import this file: it reads a copy generated from
 * `contracts/realtime/events.json` (C-08). This holds the two to one list, so a
 * rename here goes red until the fixture — and with it the panel — agrees.
 */
const FIXTURE = join(__dirname, '../../../../../contracts/realtime/events.json');

describe('contracts/realtime/events.json', () => {
  it('declares exactly the outbox event types routing-keys.ts exports', () => {
    const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as { realtimeEvents: Record<string, string> };
    const { note: _note, ...events } = fixture.realtimeEvents;
    expect(Object.values(events).sort()).toEqual(Object.values(OutboxEventType).sort());
  });
});
