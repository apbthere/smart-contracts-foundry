# USDC Escrow

USDC escrow for Base. Funds are held until a signed verdict settles them. Refunds work without the operator, and the contract owner has no path to a counterparty's money.

## Contracts

| File | Role |
|---|---|
| `src/UsdcEscrow.sol` | Holds funds, enforces the settlement rules |
| `src/VerdictVerifier.sol` | Checks a verdict's EIP-712 signature (audience + expiry) |
| `src/interfaces/IUSDC.sol` | The FiatToken v2.2 functions used (EIP-3009) |

## Lifecycle

An escrow's id is `keccak256(abi.encode(buyer, terms))`, where `terms = (seller, refundTo, verifier, amount, deadline, salt)`. Ids are deterministic and computable off-chain, and a verdict for one escrow can't be applied to different terms.

**Funding**
- `createEscrow(terms)`: buyer calls it after `usdc.approve(escrow, amount)`.
- `createEscrowWithAuthorization(buyer, terms, validAfter, validBefore, sig)`: the buyer signs an EIP-3009 `ReceiveWithAuthorization` with `nonce = computeEscrowId(buyer, terms)`, and **anyone** submits it. This is gasless for the buyer and works for smart-account (ERC-1271) buyers. Because the terms are bound into the nonce, a relayer can't change them.

**Settlement** (each Funded escrow settles exactly once)

| Function | Caller | When | Funds go to |
|---|---|---|---|
| `executeVerdict(id, toSeller, expiry, sig)` | anyone | `now <= deadline` and `now <= expiry` | `toSeller` → seller, rest → refundTo |
| `release(id)` | buyer | any time | all → seller |
| `refund(id)` | seller | any time | all → refundTo |
| `refundExpired(id)` | anyone | `now > deadline` | all → refundTo |

The verdict and expiry-refund windows don't overlap, so they can never race.

**Payouts** are pushed. If a transfer fails (blacklisted payee, paused USDC), the amount is credited to `owed[account]` instead. Anyone can later call `withdraw(account)`, which pays only `account`. A blacklisted seller therefore can't block the buyer's share.

## Verdict format (EIP-712)

```
domain: { name: "UsdcEscrow", version: "1", chainId, verifyingContract }
Verdict(bytes32 escrowId, uint256 toSeller, uint64 expiry)
```

- **Audience:** `chainId` plus `verifyingContract`, so a verdict is valid only on this deployment.
- **Signer:** the verifier saved in the escrow at creation. It can be an EOA (ECDSA) or a contract such as a multisig (ERC-1271).
- `verdictDigest(escrowId, toSeller, expiry)` returns the exact digest to sign.

## Owner powers

The only owner power is `setVerifier`, which applies to **new** escrows only. Creating an escrow requires `terms.verifier == verifier()`, so the buyer explicitly agrees to the verifier, and later rotations can't reach existing escrows. The contract isn't upgradeable or pausable and has no sweep function. Ownership transfer is two-step (`Ownable2Step`).

## Usage

```shell
forge build
forge test                                               # unit + invariant (fork tests skipped)
BASE_RPC_URL=https://mainnet.base.org forge test --mc Fork   # against real USDC on a Base fork

VERIFIER=0x... OWNER=0x... forge script script/DeployUsdcEscrow.s.sol \
  --rpc-url https://mainnet.base.org --broadcast --account <keystore> --verify
```

USDC defaults by chain: Base `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, Base Sepolia `0x036CbD53842c5426634e7929541eC2318f3dCF7e`. Override with `USDC_ADDRESS`.

## Agents and account abstraction

The escrow authorizes by `msg.sender` and checks signatures with `SignatureChecker` (ECDSA or ERC-1271). Any ERC-4337 / ERC-7579 / EIP-7702 account works as buyer or seller. Session keys belong in the account: scope them to this contract, the needed functions, a USDC cap, and an expiry. Verdict execution, expiry refunds, withdrawals and authorization funding are all permissionless, so a bundler or relayer can submit them.

## Known limits

- If Circle blacklists the escrow contract itself, all funds are frozen. No contract design can avoid this.
- Fee-on-transfer behaviour (if USDC ever adds it) makes funding revert (`UnexpectedAmountReceived`) rather than under-collateralize an escrow.
- No platform fee, no top-ups, no deadline extensions.
