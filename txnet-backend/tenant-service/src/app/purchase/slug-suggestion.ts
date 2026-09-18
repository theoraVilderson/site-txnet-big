/**
 * A slug suggested from the name a buyer types (F-019-h, user 2026-09-18:
 * automatic, close to the name, and the buyer may edit it before buying).
 *
 * Most buyers type a Persian name, which has no letters a DNS label accepts;
 * dropping them would leave nothing to suggest, so each letter becomes its
 * usual Latin spelling first. Vowels Persian does not write stay unwritten —
 * `علی` is `aly` — which is close enough to recognise and the buyer edits it.
 */

const TRANSLITERATION: Record<string, string> = {
  ا: 'a', آ: 'a', أ: 'a', إ: 'e', ء: '', ئ: 'y', ؤ: 'v',
  ب: 'b', پ: 'p', ت: 't', ث: 's', ج: 'j', چ: 'ch', ح: 'h', خ: 'kh',
  د: 'd', ذ: 'z', ر: 'r', ز: 'z', ژ: 'zh', س: 's', ش: 'sh', ص: 's',
  ض: 'z', ط: 't', ظ: 'z', ع: 'a', غ: 'gh', ف: 'f', ق: 'gh', ک: 'k',
  ك: 'k', گ: 'g', ل: 'l', م: 'm', ن: 'n', و: 'v', ه: 'h', ة: 'h',
  ی: 'y', ي: 'y', ى: 'y',
  '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4', '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9',
  '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
};

/** What a name with nothing usable in it suggests. */
export const SLUG_FALLBACK = 'reseller';

/** Room left in the 63-character label for a `-NN` suffix. */
const MAX_BASE = 50;

/** How many `-2`, `-3`, … are tried beside a taken base before a random suffix. */
export const SUFFIX_TRIES = 20;

/** The name as one lower-case DNS label, at most {@link MAX_BASE} characters; never empty. */
export function slugFromName(name: string): string {
  const latin = Array.from(name, (ch) => TRANSLITERATION[ch] ?? ch)
    .join('')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();
  const slug = latin
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_BASE)
    .replace(/-+$/, '');
  return slug || SLUG_FALLBACK;
}

/** `base`, then `base-2` … `base-{SUFFIX_TRIES}`, in the order they are offered. */
export function slugCandidates(base: string): string[] {
  return [base, ...Array.from({ length: SUFFIX_TRIES - 1 }, (_, i) => `${base}-${i + 2}`)];
}
