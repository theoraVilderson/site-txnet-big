import { renewalOpenCallback } from '@txnet-backend/shared-core';
import { noticeButton } from './notice-buttons';

/**
 * F-305-i (user, 2026-10-22): a notice a renewal answers carries the bot's
 * «تمدید», which opens that service's plans in the chat — and only those: a
 * metered Grant's stop is answered by a top-up, a capped one's by its cap.
 */
const GRANT = '0f0e0d0c-0b0a-4908-8706-050403020100';
const ns = { retention: { renewButton: '🔄 تمدید' } };

describe('the renew notices carry the bot renewal (F-305-i)', () => {
  it.each(['serviceEnded', 'serviceVolumeSpent', 'servicePurgeSoon'])('%s opens that Grant\'s renewal, in the user\'s words', (template) => {
    expect(noticeButton(template, { grantId: GRANT }, ns)).toEqual({ inline_keyboard: [[{ text: '🔄 تمدید', callback_data: renewalOpenCallback(GRANT) }]] });
  });

  it.each(['serviceWalletSpent', 'serviceCapReached', 'servicePurgeSoonTopUp', 'servicePurgeSoonRaiseCap'])('%s has none', (template) => {
    expect(noticeButton(template, { grantId: GRANT }, ns)).toBeUndefined();
  });

  it('a combined notice names no Grant, so it has none', () => {
    expect(noticeButton('serviceEnded', { count: '3' }, ns)).toBeUndefined();
  });
});
