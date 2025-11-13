// tests/EnergyOracle.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { Cl, uintCV, principalCV, buffCV } from "@stacks/transactions";

const ERR_NOT_AUTHORIZED = 100n;
const ERR_INVALID_PROOF = 101n;
const ERR_PROOF_EXPIRED = 103n;
const ERR_PROOF_TOO_EARLY = 104n;
const ERR_ORACLE_NOT_AUTHORIZED = 106n;
const ERR_PROOF_ALREADY_EXISTS = 107n;
const ERR_INVALID_SIGNATURE = 108n;
const ERR_INVALID_EXCESS_AMOUNT = 110n;
const ERR_PROOF_REVOKED = 115n;
const ERR_ORACLE_INACTIVE = 116n;

interface Oracle {
  active: boolean;
  stake: bigint;
  lastSubmission: bigint;
  successCount: bigint;
  failureCount: bigint;
  joinedAt: bigint;
}

interface Proof {
  excessKwh: bigint;
  timestamp: bigint;
  submitters: string[];
  signatures: string[];
  hashChain: string;
  revoked: boolean;
}

interface ProofIndex {
  producer: string;
  block: bigint;
}

interface OracleSubmission {
  submittedAt: bigint;
}

class EnergyOracleMock {
  private oracles = new Map<string, Oracle>();
  private producerProofs = new Map<string, Proof>();
  private proofIndex = new Map<bigint, ProofIndex>();
  private oracleSubmissions = new Map<string, OracleSubmission>();
  public oracleNonce = 0n;
  public minQuorum = 3n;
  public maxProofAge = 720n;
  public blockHeight = 1000n;
  public caller = "ST1TESTORACLE";
  public owner = "ST1OWNER";

  constructor() {
    this.reset();
  }

  reset() {
    this.oracles.clear();
    this.producerProofs.clear();
    this.proofIndex.clear();
    this.oracleSubmissions.clear();
    this.oracleNonce = 0n;
    this.minQuorum = 3n;
    this.blockHeight = 1000n;
    this.caller = "ST1TESTORACLE";
  }

  private proofKey(producer: string, block: bigint): string {
    return `${producer}#${block}`;
  }

  private hashProofData(producer: string, block: bigint, excessKwh: bigint, timestamp: bigint): string {
    return `hash-${producer}-${block}-${excessKwh}-${timestamp}`;
  }

  private verifySignature(messageHash: string, signature: string, pubkey: string): boolean {
    return signature === "valid-sig" && pubkey === "ST1PRODUCER";
  }

  getOracle(operator: string): Oracle | null {
    return this.oracles.get(operator) || null;
  }

  getProof(producer: string, block: bigint): Proof | null {
    return this.producerProofs.get(this.proofKey(producer, block)) || null;
  }

  getProofById(proofId: bigint): Proof | null {
    const index = this.proofIndex.get(proofId);
    if (!index) return null;
    return this.getProof(index.producer, index.block);
  }

  isOracleActive(operator: string): boolean {
    const oracle = this.oracles.get(operator);
    return oracle?.active ?? false;
  }

  registerOracle(stake: bigint): { ok: boolean; value: boolean } {
    if (this.oracles.has(this.caller)) return { ok: false, value: false };
    if (stake < 1000000n) return { ok: false, value: false };
    this.oracles.set(this.caller, {
      active: true,
      stake,
      lastSubmission: 0n,
      successCount: 0n,
      failureCount: 0n,
      joinedAt: this.blockHeight
    });
    return { ok: true, value: true };
  }

  deregisterOracle(): { ok: boolean; value: boolean } {
    const oracle = this.oracles.get(this.caller);
    if (!oracle || !oracle.active) return { ok: false, value: false };
    this.oracles.set(this.caller, { ...oracle, active: false });
    return { ok: true, value: true };
  }

  submitProof(
    producer: string,
    block: bigint,
    excessKwh: bigint,
    timestamp: bigint,
    signature: string
  ): { ok: boolean; value: bigint } {
    const oracle = this.oracles.get(this.caller);
    if (!oracle || !oracle.active) return { ok: false, value: ERR_ORACLE_INACTIVE };
    const key = this.proofKey(producer, block);
    if (this.producerProofs.has(key)) return { ok: false, value: ERR_PROOF_ALREADY_EXISTS };
    if (excessKwh <= 0n) return { ok: false, value: ERR_INVALID_EXCESS_AMOUNT };
    const age = this.blockHeight - block;
    if (age < 1n || age > this.maxProofAge) return { ok: false, value: ERR_PROOF_EXPIRED };
    if (timestamp < block * 600n) return { ok: false, value: ERR_PROOF_TOO_EARLY };
    const messageHash = this.hashProofData(producer, block, excessKwh, timestamp);
    if (!this.verifySignature(messageHash, signature, producer)) {
      return { ok: false, value: ERR_INVALID_SIGNATURE };
    }
    const proofId = this.oracleNonce;
    const proof: Proof = {
      excessKwh,
      timestamp,
      submitters: [this.caller],
      signatures: [signature],
      hashChain: messageHash,
      revoked: false
    };
    this.producerProofs.set(key, proof);
    this.proofIndex.set(proofId, { producer, block });
    this.oracleSubmissions.set(`${this.caller}#${proofId}`, { submittedAt: this.blockHeight });
    this.oracleNonce += 1n;
    this.oracles.set(this.caller, {
      ...oracle,
      lastSubmission: this.blockHeight,
      successCount: oracle.successCount + 1n
    });
    return { ok: true, value: proofId };
  }

  confirmProof(proofId: bigint, signature: string): { ok: boolean; value: boolean } {
    const index = this.proofIndex.get(proofId);
    if (!index) return { ok: false, value: false };
    const key = this.proofKey(index.producer, index.block);
    const proof = this.producerProofs.get(key);
    if (!proof || proof.revoked) return { ok: false, value: false };
    const oracle = this.oracles.get(this.caller);
    if (!oracle || !oracle.active) return { ok: false, value: false };
    if (proof.submitters.includes(this.caller)) return { ok: false, value: false };
    if (!this.verifySignature(proof.hashChain, signature, index.producer)) {
      return { ok: false, value: false };
    }
    const updatedSubmitters = [...proof.submitters, this.caller].slice(0, 10);
    const updatedSignatures = [...proof.signatures, signature].slice(0, 10);
    this.producerProofs.set(key, {
      ...proof,
      submitters: updatedSubmitters,
      signatures: updatedSignatures
    });
    this.oracleSubmissions.set(`${this.caller}#${proofId}`, { submittedAt: this.blockHeight });
    this.oracles.set(this.caller, {
      ...oracle,
      lastSubmission: this.blockHeight,
      successCount: oracle.successCount + 1n
    });
    return { ok: true, value: true };
  }

  revokeProof(producer: string, block: bigint): { ok: boolean; value: boolean } {
    const key = this.proofKey(producer, block);
    const proof = this.producerProofs.get(key);
    if (!proof) return { ok: false, value: false };
    const isOwner = this.caller === this.owner;
    const isProducer = this.caller === producer;
    const isOracleWithFailures = this.isOracleActive(this.caller) &&
      (this.oracles.get(this.caller)?.failureCount ?? 0n) > 5n;
    if (!(isOwner || isProducer || isOracleWithFailures)) return { ok: false, value: false };
    this.producerProofs.set(key, { ...proof, revoked: true });
    return { ok: true, value: true };
  }

  setQuorum(newQuorum: bigint): { ok: boolean; value: boolean } {
    if (this.caller !== this.owner) return { ok: false, value: false };
    if (newQuorum <= 0n || newQuorum > 10n) return { ok: false, value: false };
    this.minQuorum = newQuorum;
    return { ok: true, value: true };
  }

  isProofConfirmed(producer: string, block: bigint): boolean {
    const proof = this.getProof(producer, block);
    if (!proof || proof.revoked) return false;
    const activeCount = proof.submitters.filter(o => this.isOracleActive(o)).length;
    return BigInt(activeCount) >= this.minQuorum;
  }

  getConfirmedExcess(producer: string, startBlock: bigint, endBlock: bigint): bigint {
    let total = 0n;
    for (let b = startBlock; b <= endBlock && b < startBlock + 5n; b++) {
      if (this.isProofConfirmed(producer, b)) {
        const proof = this.getProof(producer, b);
        if (proof) total += proof.excessKwh;
      }
    }
    return total;
  }
}

describe("EnergyOracle", () => {
  let mock: EnergyOracleMock;

  beforeEach(() => {
    mock = new EnergyOracleMock();
    mock.reset();
  });

  it("registers oracle successfully", () => {
    const result = mock.registerOracle(5000000n);
    expect(result.ok).toBe(true);
    expect(result.value).toBe(true);
    const oracle = mock.getOracle("ST1TESTORACLE");
    expect(oracle?.active).toBe(true);
    expect(oracle?.stake).toBe(5000000n);
  });

  it("rejects oracle registration with low stake", () => {
    const result = mock.registerOracle(1000n);
    expect(result.ok).toBe(false);
  });

  it("rejects duplicate oracle registration", () => {
    mock.registerOracle(2000000n);
    const result = mock.registerOracle(3000000n);
    expect(result.ok).toBe(false);
  });

  it("deregisters oracle successfully", () => {
    mock.registerOracle(2000000n);
    const result = mock.deregisterOracle();
    expect(result.ok).toBe(true);
    const oracle = mock.getOracle("ST1TESTORACLE");
    expect(oracle?.active).toBe(false);
  });

  it("rejects deregister inactive oracle", () => {
    const result = mock.deregisterOracle();
    expect(result.ok).toBe(false);
  });

  it("submits proof successfully", () => {
    mock.registerOracle(2000000n);
    mock.caller = "ST1TESTORACLE";
    const result = mock.submitProof("ST1PRODUCER", 950n, 150n, 570000n, "valid-sig");
    expect(result.ok).toBe(true);
    expect(result.value).toBe(0n);
    const proof = mock.getProof("ST1PRODUCER", 950n);
    expect(proof?.excessKwh).toBe(150n);
    expect(proof?.submitters).toEqual(["ST1TESTORACLE"]);
  });

  it("rejects proof from inactive oracle", () => {
    const result = mock.submitProof("ST1PRODUCER", 950n, 150n, 570000n, "valid-sig");
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_ORACLE_INACTIVE);
  });

  it("rejects duplicate proof submission", () => {
    mock.registerOracle(2000000n);
    mock.submitProof("ST1PRODUCER", 950n, 150n, 570000n, "valid-sig");
    const result = mock.submitProof("ST1PRODUCER", 950n, 200n, 570000n, "valid-sig");
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_PROOF_ALREADY_EXISTS);
  });

  it("rejects proof with zero excess", () => {
    mock.registerOracle(2000000n);
    const result = mock.submitProof("ST1PRODUCER", 950n, 0n, 570000n, "valid-sig");
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_INVALID_EXCESS_AMOUNT);
  });

  it("rejects expired proof", () => {
    mock.registerOracle(2000000n);
    mock.blockHeight = 2000n;
    const result = mock.submitProof("ST1PRODUCER", 1000n, 150n, 600000n, "valid-sig");
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_PROOF_EXPIRED);
  });

  it("confirms proof and reaches quorum", () => {
    mock.registerOracle(2000000n);
    mock.caller = "ST1TESTORACLE";
    mock.submitProof("ST1PRODUCER", 950n, 150n, 570000n, "valid-sig");
    mock.caller = "ST2ORACLE";
    mock.registerOracle(3000000n);
    const confirm1 = mock.confirmProof(0n, "valid-sig");
    mock.caller = "ST3ORACLE";
    mock.registerOracle(4000000n);
    const confirm2 = mock.confirmProof(0n, "valid-sig");
    expect(confirm1.ok).toBe(true);
    expect(confirm2.ok).toBe(true);
    expect(mock.isProofConfirmed("ST1PRODUCER", 950n)).toBe(true);
  });

  it("rejects confirmation from same oracle", () => {
    mock.registerOracle(2000000n);
    mock.submitProof("ST1PRODUCER", 950n, 150n, 570000n, "valid-sig");
    const result = mock.confirmProof(0n, "valid-sig");
    expect(result.ok).toBe(false);
  });

  it("revokes proof by owner", () => {
    mock.owner = "ST1TESTORACLE";
    mock.registerOracle(2000000n);
    mock.submitProof("ST1PRODUCER", 950n, 150n, 570000n, "valid-sig");
    const result = mock.revokeProof("ST1PRODUCER", 950n);
    expect(result.ok).toBe(true);
    const proof = mock.getProof("ST1PRODUCER", 950n);
    expect(proof?.revoked).toBe(true);
  });

  it("sets quorum successfully", () => {
    mock.caller = mock.owner;
    const result = mock.setQuorum(5n);
    expect(result.ok).toBe(true);
    expect(mock.minQuorum).toBe(5n);
  });

  it("rejects invalid quorum", () => {
    mock.caller = mock.owner;
    const result = mock.setQuorum(15n);
    expect(result.ok).toBe(false);
  });

  it("calculates confirmed excess over block range", () => {
    mock.registerOracle(2000000n);
    mock.caller = "ST1TESTORACLE";
    mock.submitProof("ST1PRODUCER", 950n, 100n, 570000n, "valid-sig");
    mock.caller = "ST2ORACLE";
    mock.registerOracle(2000000n);
    mock.confirmProof(0n, "valid-sig");
    mock.caller = "ST3ORACLE";
    mock.registerOracle(2000000n);
    mock.confirmProof(0n, "valid-sig");
    const excess = mock.getConfirmedExcess("ST1PRODUCER", 950n, 954n);
    expect(excess).toBe(100n);
  });

  it("returns zero for unconfirmed excess", () => {
    mock.registerOracle(2000000n);
    mock.submitProof("ST1PRODUCER", 950n, 100n, 570000n, "valid-sig");
    const excess = mock.getConfirmedExcess("ST1PRODUCER", 950n, 954n);
    expect(excess).toBe(0n);
  });

  it("handles max submitter list limit", () => {
    mock.registerOracle(2000000n);
    mock.submitProof("ST1PRODUCER", 950n, 100n, 570000n, "valid-sig");
    for (let i = 1; i < 10; i++) {
      mock.caller = `ST${i + 1}ORACLE`;
      mock.registerOracle(1000000n + BigInt(i * 100000));
      mock.confirmProof(0n, "valid-sig");
    }
    const proof = mock.getProof("ST1PRODUCER", 950n);
    expect(proof?.submitters.length).toBe(10);
  });

  it("prevents replay of confirmation", () => {
    mock.registerOracle(2000000n);
    mock.submitProof("ST1PRODUCER", 950n, 100n, 570000n, "valid-sig");
    mock.caller = "ST2ORACLE";
    mock.registerOracle(2000000n);
    mock.confirmProof(0n, "valid-sig");
    const result = mock.confirmProof(0n, "valid-sig");
    expect(result.ok).toBe(false);
  });

  it("allows revocation by producer", () => {
    mock.registerOracle(2000000n);
    mock.submitProof("ST1PRODUCER", 950n, 150n, 570000n, "valid-sig");
    mock.caller = "ST1PRODUCER";
    const result = mock.revokeProof("ST1PRODUCER", 950n);
    expect(result.ok).toBe(true);
  });

  it("allows revocation by oracle with many failures", () => {
    mock.registerOracle(2000000n);
    mock.submitProof("ST1PRODUCER", 950n, 150n, 570000n, "valid-sig");
    const oracle = mock.getOracle("ST1TESTORACLE");
    if (oracle) {
      oracle.failureCount = 6n;
      mock.oracles.set("ST1TESTORACLE", oracle);
    }
    const result = mock.revokeProof("ST1PRODUCER", 950n);
    expect(result.ok).toBe(true);
  });
});