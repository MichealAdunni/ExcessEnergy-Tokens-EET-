// token-minter.test.ts

import { describe, it, expect, beforeEach } from "vitest";
import { ClarityValue, uintCV } from "@stacks/transactions";

const ERR_NOT_REGISTERED = 200;
const ERR_INSUFFICIENT_PROOF = 201;
const ERR_INVALID_AMOUNT = 202;
const ERR_BURN_FAILED = 208;
const ERR_TRANSFER_FAILED = 209;
const ERR_NOT_AUTHORIZED = 204;
const ERR_INVALID_RECIPIENT = 211;
const ERR_ZERO_AMOUNT = 212;
const ERR_INVALID_PROOF_ID = 207;

interface Proof {
  excessKwh: number;
  timestamp: number;
  producer: string;
}

interface MintedProof {
  mintedAmount: number;
  timestamp: number;
}

interface Result<T> {
  ok: boolean;
  value: T;
}

class TokenMinterMock {
  state: {
    contractOwner: string;
    paused: boolean;
    totalMinted: number;
    oracleContract: string;
    registryContract: string;
    mintFeeRecipient: string;
    balances: Map<string, number>;
    totalSupply: number;
    mintedProofs: Map<number, MintedProof>;
    userMintHistory: Map<string, number[]>;
  } = {
    contractOwner: "ST1OWNER",
    paused: false,
    totalMinted: 0,
    oracleContract: "ST1ORACLE",
    registryContract: "ST1REGISTRY",
    mintFeeRecipient: "ST1OWNER",
    balances: new Map(),
    totalSupply: 0,
    mintedProofs: new Map(),
    userMintHistory: new Map(),
  };
  blockHeight: number = 0;
  caller: string = "ST1MINTER";
  proofs: Map<number, Proof> = new Map();
  registeredProducers: Set<string> = new Set(["ST1MINTER"]);
  stxTransfers: Array<{ amount: number; from: string; to: string }> = [];

  constructor() {
    this.reset();
  }

  reset() {
    this.state = {
      contractOwner: "ST1OWNER",
      paused: false,
      totalMinted: 0,
      oracleContract: "ST1ORACLE",
      registryContract: "ST1REGISTRY",
      mintFeeRecipient: "ST1OWNER",
      balances: new Map(),
      totalSupply: 0,
      mintedProofs: new Map(),
      userMintHistory: new Map(),
    };
    this.blockHeight = 0;
    this.caller = "ST1MINTER";
    this.proofs = new Map();
    this.registeredProducers = new Set(["ST1MINTER"]);
    this.stxTransfers = [];
  }

  getBalance(account: string): Result<number> {
    return { ok: true, value: this.state.balances.get(account) || 0 };
  }

  getTotalSupply(): Result<number> {
    return { ok: true, value: this.state.totalSupply };
  }

  getName(): Result<string> {
    return { ok: true, value: "ExcessEnergyToken" };
  }

  getSymbol(): Result<string> {
    return { ok: true, value: "EET" };
  }

  getDecimals(): Result<number> {
    return { ok: true, value: 6 };
  }

  getTokenUri(): Result<string | null> {
    return { ok: true, value: "https://example.com/eet-metadata.json" };
  }

  getMintableAmount(proofId: number): Result<number> {
    const proof = this.proofs.get(proofId);
    if (!proof) return { ok: false, value: ERR_INVALID_PROOF_ID };
    const minted = this.state.mintedProofs.get(proofId) || { mintedAmount: 0, timestamp: 0 };
    return { ok: true, value: Math.max(0, proof.excessKwh - minted.mintedAmount) };
  }

  isProofMinted(proofId: number): Result<boolean> {
    return { ok: true, value: this.state.mintedProofs.has(proofId) };
  }

  getMintedProof(proofId: number): MintedProof | null {
    return this.state.mintedProofs.get(proofId) || null;
  }

  getUserMintHistory(user: string): number[] | null {
    return this.state.userMintHistory.get(user) || null;
  }

  isPaused(): Result<boolean> {
    return { ok: true, value: this.state.paused };
  }

  getContractOwner(): Result<string> {
    return { ok: true, value: this.state.contractOwner };
  }

  mintTokens(amount: number, proofId: number): Result<number> {
    if (this.state.paused) return { ok: false, value: ERR_INVALID_PROOF_ID };
    if (!this.registeredProducers.has(this.caller)) return { ok: false, value: ERR_NOT_REGISTERED };
    const proof = this.proofs.get(proofId);
    if (!proof) return { ok: false, value: ERR_INVALID_PROOF_ID };
    const minted = this.state.mintedProofs.get(proofId) || { mintedAmount: 0, timestamp: 0 };
    const fee = Math.floor(amount * 0.01);
    const netAmount = amount - fee;
    if (proof.producer !== this.caller || proof.excessKwh < netAmount + minted.mintedAmount ||
        this.blockHeight - proof.timestamp > 144 || netAmount <= 0 || netAmount > 1000000) {
      return { ok: false, value: ERR_INSUFFICIENT_PROOF };
    }
    if (this.state.totalMinted + netAmount > 1000000000000) return { ok: false, value: ERR_INVALID_PROOF_ID };
    this.state.balances.set(this.caller, (this.state.balances.get(this.caller) || 0) + netAmount);
    this.state.totalSupply += netAmount;
    this.state.totalMinted += netAmount;
    this.stxTransfers.push({ amount: fee, from: this.caller, to: this.state.mintFeeRecipient });
    this.state.mintedProofs.set(proofId, { mintedAmount: minted.mintedAmount + netAmount, timestamp: this.blockHeight });
    const history = this.state.userMintHistory.get(this.caller) || [];
    this.state.userMintHistory.set(this.caller, [...history, proofId]);
    return { ok: true, value: netAmount };
  }

  burnTokens(amount: number): Result<number> {
    if (amount <= 0) return { ok: false, value: ERR_ZERO_AMOUNT };
    const balance = this.state.balances.get(this.caller) || 0;
    if (balance < amount) return { ok: false, value: ERR_BURN_FAILED };
    this.state.balances.set(this.caller, balance - amount);
    this.state.totalSupply -= amount;
    return { ok: true, value: amount };
  }

  transfer(amount: number, sender: string, recipient: string): Result<boolean> {
    if (this.caller !== sender) return { ok: false, value: false };
    if (amount <= 0) return { ok: false, value: false };
    if (recipient === sender) return { ok: false, value: false };
    const senderBalance = this.state.balances.get(sender) || 0;
    if (senderBalance < amount) return { ok: false, value: false };
    this.state.balances.set(sender, senderBalance - amount);
    this.state.balances.set(recipient, (this.state.balances.get(recipient) || 0) + amount);
    return { ok: true, value: true };
  }

  pauseContract(): Result<boolean> {
    if (this.caller !== this.state.contractOwner) return { ok: false, value: false };
    this.state.paused = true;
    return { ok: true, value: true };
  }

  unpauseContract(): Result<boolean> {
    if (this.caller !== this.state.contractOwner) return { ok: false, value: false };
    this.state.paused = false;
    return { ok: true, value: true };
  }

  setMintFeeRecipient(newRecipient: string): Result<boolean> {
    if (this.caller !== this.state.contractOwner) return { ok: false, value: false };
    this.state.mintFeeRecipient = newRecipient;
    return { ok: true, value: true };
  }

  setOracleContract(newOracle: string): Result<boolean> {
    if (this.caller !== this.state.contractOwner) return { ok: false, value: false };
    this.state.oracleContract = newOracle;
    return { ok: true, value: true };
  }

  setRegistryContract(newRegistry: string): Result<boolean> {
    if (this.caller !== this.state.contractOwner) return { ok: false, value: false };
    this.state.registryContract = newRegistry;
    return { ok: true, value: true };
  }

  transferOwnership(newOwner: string): Result<boolean> {
    if (this.caller !== this.state.contractOwner) return { ok: false, value: false };
    if (newOwner === this.caller) return { ok: false, value: false };
    this.state.contractOwner = newOwner;
    return { ok: true, value: true };
  }

  addProof(proofId: number, excessKwh: number, timestamp: number, producer: string) {
    this.proofs.set(proofId, { excessKwh, timestamp, producer });
  }
}

describe("TokenMinter", () => {
  let contract: TokenMinterMock;

  beforeEach(() => {
    contract = new TokenMinterMock();
    contract.reset();
  });

  it("gets balance successfully", () => {
    const result = contract.getBalance("ST1MINTER");
    expect(result.ok).toBe(true);
    expect(result.value).toBe(0);
  });

  it("gets total supply successfully", () => {
    const result = contract.getTotalSupply();
    expect(result.ok).toBe(true);
    expect(result.value).toBe(0);
  });

  it("gets name successfully", () => {
    const result = contract.getName();
    expect(result.ok).toBe(true);
    expect(result.value).toBe("ExcessEnergyToken");
  });

  it("gets symbol successfully", () => {
    const result = contract.getSymbol();
    expect(result.ok).toBe(true);
    expect(result.value).toBe("EET");
  });

  it("gets decimals successfully", () => {
    const result = contract.getDecimals();
    expect(result.ok).toBe(true);
    expect(result.value).toBe(6);
  });

  it("gets token uri successfully", () => {
    const result = contract.getTokenUri();
    expect(result.ok).toBe(true);
    expect(result.value).toBe("https://example.com/eet-metadata.json");
  });

  it("mints tokens successfully", () => {
    contract.addProof(1, 1000, 0, "ST1MINTER");
    const result = contract.mintTokens(1000, 1);
    expect(result.ok).toBe(true);
    expect(result.value).toBe(990);
    expect(contract.getBalance("ST1MINTER").value).toBe(990);
    expect(contract.getTotalSupply().value).toBe(990);
    expect(contract.stxTransfers).toEqual([{ amount: 10, from: "ST1MINTER", to: "ST1OWNER" }]);
  });

  it("rejects mint for unregistered producer", () => {
    contract.registeredProducers.clear();
    const result = contract.mintTokens(1000, 1);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_NOT_REGISTERED);
  });

  it("rejects mint with invalid proof id", () => {
    const result = contract.mintTokens(1000, 999);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_INVALID_PROOF_ID);
  });

  it("burns tokens successfully", () => {
    contract.state.balances.set("ST1MINTER", 1000);
    contract.state.totalSupply = 1000;
    const result = contract.burnTokens(500);
    expect(result.ok).toBe(true);
    expect(result.value).toBe(500);
    expect(contract.getBalance("ST1MINTER").value).toBe(500);
    expect(contract.getTotalSupply().value).toBe(500);
  });

  it("rejects burn with zero amount", () => {
    const result = contract.burnTokens(0);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_ZERO_AMOUNT);
  });

  it("rejects burn exceeding balance", () => {
    const result = contract.burnTokens(1000);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_BURN_FAILED);
  });

  it("transfers tokens successfully", () => {
    contract.state.balances.set("ST1MINTER", 1000);
    const result = contract.transfer(500, "ST1MINTER", "ST2RECIPIENT");
    expect(result.ok).toBe(true);
    expect(result.value).toBe(true);
    expect(contract.getBalance("ST1MINTER").value).toBe(500);
    expect(contract.getBalance("ST2RECIPIENT").value).toBe(500);
  });

  it("rejects transfer from non-sender", () => {
    const result = contract.transfer(500, "ST3OTHER", "ST2RECIPIENT");
    expect(result.ok).toBe(false);
    expect(result.value).toBe(false);
  });

  it("rejects transfer to self", () => {
    const result = contract.transfer(500, "ST1MINTER", "ST1MINTER");
    expect(result.ok).toBe(false);
    expect(result.value).toBe(false);
  });

  it("rejects transfer exceeding balance", () => {
    const result = contract.transfer(500, "ST1MINTER", "ST2RECIPIENT");
    expect(result.ok).toBe(false);
    expect(result.value).toBe(false);
  });

  it("pauses contract successfully", () => {
    contract.caller = "ST1OWNER";
    const result = contract.pauseContract();
    expect(result.ok).toBe(true);
    expect(result.value).toBe(true);
    expect(contract.isPaused().value).toBe(true);
  });

  it("rejects pause by non-owner", () => {
    const result = contract.pauseContract();
    expect(result.ok).toBe(false);
    expect(result.value).toBe(false);
  });

  it("unpauses contract successfully", () => {
    contract.caller = "ST1OWNER";
    contract.state.paused = true;
    const result = contract.unpauseContract();
    expect(result.ok).toBe(true);
    expect(result.value).toBe(true);
    expect(contract.isPaused().value).toBe(false);
  });

  it("rejects unpause by non-owner", () => {
    const result = contract.unpauseContract();
    expect(result.ok).toBe(false);
    expect(result.value).toBe(false);
  });

  it("sets mint fee recipient successfully", () => {
    contract.caller = "ST1OWNER";
    const result = contract.setMintFeeRecipient("ST3NEW");
    expect(result.ok).toBe(true);
    expect(result.value).toBe(true);
    expect(contract.state.mintFeeRecipient).toBe("ST3NEW");
  });

  it("rejects set mint fee recipient by non-owner", () => {
    const result = contract.setMintFeeRecipient("ST3NEW");
    expect(result.ok).toBe(false);
    expect(result.value).toBe(false);
  });

  it("sets oracle contract successfully", () => {
    contract.caller = "ST1OWNER";
    const result = contract.setOracleContract("ST4NEW");
    expect(result.ok).toBe(true);
    expect(result.value).toBe(true);
    expect(contract.state.oracleContract).toBe("ST4NEW");
  });

  it("rejects set oracle by non-owner", () => {
    const result = contract.setOracleContract("ST4NEW");
    expect(result.ok).toBe(false);
    expect(result.value).toBe(false);
  });

  it("sets registry contract successfully", () => {
    contract.caller = "ST1OWNER";
    const result = contract.setRegistryContract("ST5NEW");
    expect(result.ok).toBe(true);
    expect(result.value).toBe(true);
    expect(contract.state.registryContract).toBe("ST5NEW");
  });

  it("rejects set registry by non-owner", () => {
    const result = contract.setRegistryContract("ST5NEW");
    expect(result.ok).toBe(false);
    expect(result.value).toBe(false);
  });

  it("transfers ownership successfully", () => {
    contract.caller = "ST1OWNER";
    const result = contract.transferOwnership("ST6NEW");
    expect(result.ok).toBe(true);
    expect(result.value).toBe(true);
    expect(contract.getContractOwner().value).toBe("ST6NEW");
  });

  it("rejects transfer ownership by non-owner", () => {
    const result = contract.transferOwnership("ST6NEW");
    expect(result.ok).toBe(false);
    expect(result.value).toBe(false);
  });

  it("rejects transfer ownership to self", () => {
    contract.caller = "ST1OWNER";
    const result = contract.transferOwnership("ST1OWNER");
    expect(result.ok).toBe(false);
    expect(result.value).toBe(false);
  });

  it("gets mintable amount successfully", () => {
    contract.addProof(1, 1000, 0, "ST1MINTER");
    const result = contract.getMintableAmount(1);
    expect(result.ok).toBe(true);
    expect(result.value).toBe(1000);
  });

  it("rejects get mintable with invalid proof", () => {
    const result = contract.getMintableAmount(999);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_INVALID_PROOF_ID);
  });

  it("checks if proof minted", () => {
    contract.addProof(1, 1000, 0, "ST1MINTER");
    contract.mintTokens(500, 1);
    const result = contract.isProofMinted(1);
    expect(result.ok).toBe(true);
    expect(result.value).toBe(true);
  });

  it("gets minted proof", () => {
    contract.addProof(1, 1000, 0, "ST1MINTER");
    contract.mintTokens(500, 1);
    const proof = contract.getMintedProof(1);
    expect(proof?.mintedAmount).toBe(495);
    expect(proof?.timestamp).toBe(0);
  });

  it("gets user mint history", () => {
    contract.addProof(1, 1000, 0, "ST1MINTER");
    contract.mintTokens(500, 1);
    const history = contract.getUserMintHistory("ST1MINTER");
    expect(history).toEqual([1]);
  });

  it("rejects mint with expired proof", () => {
    contract.addProof(1, 1000, 0, "ST1MINTER");
    contract.blockHeight = 145;
    const result = contract.mintTokens(1000, 1);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_INSUFFICIENT_PROOF);
  });

  it("rejects mint exceeding proof amount", () => {
    contract.addProof(1, 1000, 0, "ST1MINTER");
    const result = contract.mintTokens(2000, 1);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_INSUFFICIENT_PROOF);
  });

  it("uses clarity types in test", () => {
    const amount = uintCV(1000);
    expect(amount.value).toEqual(BigInt(1000));
  });
});