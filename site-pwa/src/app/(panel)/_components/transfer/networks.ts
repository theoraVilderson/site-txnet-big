/**
 * The chains the panel recognises in a seller's free-text `network`
 * (billing `crypto_wallet`: "shown verbatim"), with what a tx hash on each
 * looks like and where to look one up. A reviewer's explorer link (F-803-k)
 * and the payer's hash field (F-803-j) both read this table; a chain missing
 * here only loses the link and the shape check — billing still takes the hash.
 */
export interface KnownNetwork {
  id: string;
  /** Upper-cased words of the seller's text that name this chain. */
  words: readonly string[];
  hash: RegExp;
  explorerTx: (hash: string) => string;
}

const HEX64 = /^[0-9a-fA-F]{64}$/;
const EVM_HASH = /^0x[0-9a-fA-F]{64}$/;

export const KNOWN_NETWORKS: readonly KnownNetwork[] = [
  { id: "tron", words: ["TRC20", "TRON", "TRX"], hash: HEX64, explorerTx: (h) => `https://tronscan.org/#/transaction/${h}` },
  { id: "ethereum", words: ["ERC20", "ETH", "ETHEREUM"], hash: EVM_HASH, explorerTx: (h) => `https://etherscan.io/tx/${h}` },
  { id: "bsc", words: ["BEP20", "BSC", "BNB"], hash: EVM_HASH, explorerTx: (h) => `https://bscscan.com/tx/${h}` },
  { id: "polygon", words: ["POLYGON", "MATIC", "POL"], hash: EVM_HASH, explorerTx: (h) => `https://polygonscan.com/tx/${h}` },
  { id: "bitcoin", words: ["BTC", "BITCOIN"], hash: HEX64, explorerTx: (h) => `https://mempool.space/tx/${h}` },
  { id: "litecoin", words: ["LTC", "LITECOIN"], hash: HEX64, explorerTx: (h) => `https://litecoinspace.org/tx/${h}` },
  { id: "ton", words: ["TON"], hash: /^(?:[0-9a-fA-F]{64}|[A-Za-z0-9_-]{43}=?)$/, explorerTx: (h) => `https://tonviewer.com/transaction/${h}` },
  { id: "solana", words: ["SOL", "SOLANA"], hash: /^[1-9A-HJ-NP-Za-km-z]{86,88}$/, explorerTx: (h) => `https://solscan.io/tx/${h}` },
];

/** The one chain the seller's text names, or null — for none, and for text naming two ("TRC20 or BEP20"). */
export function knownNetwork(network: string | null | undefined): KnownNetwork | null {
  if (!network) return null;
  const words = new Set(network.toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean));
  const hits = KNOWN_NETWORKS.filter((n) => n.words.some((w) => words.has(w)));
  return hits.length === 1 ? hits[0] : null;
}

/** The explorer page of a tx hash, when the network is known and the hash is that chain's shape. */
export function explorerTxUrl(network: string | null | undefined, hash: string): string | null {
  const chain = knownNetwork(network);
  return chain && chain.hash.test(hash) ? chain.explorerTx(hash) : null;
}
