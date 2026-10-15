/**
 * Iranian card issuers by BIN (the card number's first six digits), for the
 * `card_to_card` kind (F-803-b) and the drawn card on the pay page (F-803-i).
 * Data, not logic: a bank that issues a new BIN is one prefix added here and
 * in `contracts/billing/iran-banks.json`, the panel's copy (F-803-g), which
 * `card-to-card.spec.ts` holds this table to. The bank's logo asset is named
 * by its `id`; `colors` is the drawn card's gradient, from the bank's own brand.
 */
export interface IranBank {
  id: string;
  bins: readonly string[];
  colors: readonly [string, string];
}

/** A card whose BIN is in no row: still accepted, drawn plain (contract.manual-transfer.md). */
export const OTHER_BANK = 'other';

export const IRAN_BANKS: readonly IranBank[] = [
  { id: 'melli', bins: ['603799'], colors: ['#0b4ea2', '#3c7dd9'] },
  { id: 'sepah', bins: ['589210', '627381'], colors: ['#1c3f94', '#4a6fc7'] },
  { id: 'mellat', bins: ['610433', '991975'], colors: ['#b5121b', '#e2474f'] },
  { id: 'tejarat', bins: ['627353', '585983'], colors: ['#16297a', '#3e56b3'] },
  { id: 'saderat', bins: ['603769'], colors: ['#1d2f6f', '#4560b0'] },
  { id: 'keshavarzi', bins: ['603770', '639217'], colors: ['#0e6b3a', '#3fa36a'] },
  { id: 'maskan', bins: ['628023'], colors: ['#e05a12', '#f2924f'] },
  { id: 'refah', bins: ['589463'], colors: ['#18377a', '#4b6bb5'] },
  { id: 'parsian', bins: ['622106', '639194', '627884'], colors: ['#7a1120', '#b8384a'] },
  { id: 'pasargad', bins: ['502229', '639347'], colors: ['#1a1a1a', '#c9a227'] },
  { id: 'eghtesad_novin', bins: ['627412'], colors: ['#5b2a86', '#9058c2'] },
  { id: 'saman', bins: ['621986'], colors: ['#0a5aa8', '#4f93d8'] },
  { id: 'sina', bins: ['639346'], colors: ['#0f4c81', '#4483bb'] },
  { id: 'shahr', bins: ['502806', '504706'], colors: ['#c4161c', '#e85a5f'] },
  { id: 'dey', bins: ['502938'], colors: ['#00727a', '#3aa6ad'] },
  { id: 'ayandeh', bins: ['636214'], colors: ['#5a3a1e', '#a3774a'] },
  { id: 'karafarin', bins: ['627488', '502910'], colors: ['#0d7a4e', '#46b285'] },
  { id: 'sarmayeh', bins: ['639607'], colors: ['#2d3e50', '#61788f'] },
  { id: 'tosee_saderat', bins: ['627648', '207177'], colors: ['#0b6e4f', '#43a382'] },
  { id: 'post_bank', bins: ['627760'], colors: ['#0b8a43', '#4fbf7d'] },
  { id: 'tosee_taavon', bins: ['502908'], colors: ['#0f5f8a', '#4b93bd'] },
  { id: 'sanat_madan', bins: ['627961'], colors: ['#1f3a68', '#50709f'] },
  { id: 'resalat', bins: ['504172'], colors: ['#0e7c86', '#47aeb7'] },
  { id: 'mehr_iran', bins: ['606373'], colors: ['#0c7a3d', '#47ad72'] },
  { id: 'khavarmianeh', bins: ['585947', '505809'], colors: ['#d06a10', '#eda155'] },
  { id: 'iran_zamin', bins: ['505785'], colors: ['#6b2d82', '#a061b8'] },
  { id: 'gardeshgari', bins: ['505416'], colors: ['#8a1538', '#c24a6e'] },
  { id: 'melal', bins: ['606256'], colors: ['#0b5f7a', '#4392ad'] },
  { id: 'kosar', bins: ['505801'], colors: ['#1d6b2f', '#55a066'] },
  { id: 'hekmat', bins: ['636949'], colors: ['#24426b', '#5a77a1'] },
  { id: 'noor', bins: ['507677'], colors: ['#0d5c63', '#47919a'] },
  { id: 'markazi', bins: ['636795'], colors: ['#1b3a5c', '#506f93'] },
];

const BIN_LENGTH = 6;

const BANK_OF_BIN: ReadonlyMap<string, string> = new Map(IRAN_BANKS.flatMap((b) => b.bins.map((bin) => [bin, b.id] as const)));

/** Every id a card's `bankId` may hold: the table's and `other`. */
export const BANK_IDS: ReadonlySet<string> = new Set([...IRAN_BANKS.map((b) => b.id), OTHER_BANK]);

/** The issuing bank of a card number, `other` when its BIN is in no row. */
export function bankOfCard(cardNumber: string): string {
  return BANK_OF_BIN.get(cardNumber.slice(0, BIN_LENGTH)) ?? OTHER_BANK;
}
