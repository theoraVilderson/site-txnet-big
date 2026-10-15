import { proofRefusal } from "./proof-fields";
import { ADDRESS_ENDS, addressSegments } from "./wallet-address";

/**
 * F-803-j (contract.manual-transfer.md "Wallet"): the address is drawn so a
 * payer can compare its ends with their wallet's, and a tx hash is checked in
 * the shape of the seller's network before one of billing's tries is spent.
 */

const TRON = "TQrZ8tKfjA4X3yKvU9hYzWcQ5sLmN2pR7e";

describe("addressSegments", () => {
  it("sets the first and last six characters apart and groups the middle", () => {
    const s = addressSegments(TRON);
    expect(s.head).toBe(TRON.slice(0, ADDRESS_ENDS));
    expect(s.tail).toBe(TRON.slice(-ADDRESS_ENDS));
    expect(s.middle.map((g) => g.text).join("")).toBe(TRON.slice(ADDRESS_ENDS, -ADDRESS_ENDS));
    expect(s.middle.every((g) => g.text.length <= 4 && TRON.startsWith(g.text, g.at))).toBe(true);
  });

  it("loses no character and adds none, whatever the length", () => {
    for (const address of ["0x52908400098527886E0F7030069857D2E4169EE7", "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq", TRON]) {
      const s = addressSegments(address);
      expect(s.head + s.middle.map((g) => g.text).join("") + s.tail).toBe(address);
    }
  });

  it("draws an address too short to split as one emphasised run", () => {
    expect(addressSegments("abc123")).toEqual({ head: "abc123", middle: [], tail: "" });
    expect(addressSegments("  ")).toEqual({ head: "", middle: [], tail: "" });
  });
});

describe("proofRefusal txHash on a known network", () => {
  const tronHash = "a".repeat(64);
  const evmHash = `0x${"b".repeat(64)}`;

  it("takes the hash in the chain's own shape", () => {
    expect(proofRefusal("txHash", tronHash, "TRC20")).toBeNull();
    expect(proofRefusal("txHash", evmHash, "BEP20 (BSC)")).toBeNull();
  });

  it("refuses a hash of another chain's shape, which billing would take and no one could find", () => {
    expect(proofRefusal("txHash", evmHash, "TRC20")).toBe("invalid");
    expect(proofRefusal("txHash", tronHash, "ERC20")).toBe("invalid");
    expect(proofRefusal("txHash", "a".repeat(63), "TRON")).toBe("invalid");
  });

  it("falls back to billing's generic shape when the seller's network names no one chain", () => {
    expect(proofRefusal("txHash", evmHash, "my private chain")).toBeNull();
    expect(proofRefusal("txHash", evmHash, "TRC20 or BEP20")).toBeNull();
    expect(proofRefusal("txHash", evmHash)).toBeNull();
    expect(proofRefusal("txHash", "not a hash", null)).toBe("invalid");
  });

  it("leaves every other field's check as it was", () => {
    expect(proofRefusal("trackingCode", "۱۲۳۴۵۶", "TRC20")).toBeNull();
  });
});
