// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IUSDC} from "./interfaces/IUSDC.sol";
import {VerdictVerifier} from "./VerdictVerifier.sol";

/// @title UsdcEscrow
/// @notice Holds USDC until a signed verdict settles it, with refunds that need no operator.
/// @dev Guarantees:
///   - Funds only ever leave to an escrow's `seller` or `refundTo`, never to the owner or verifier.
///   - The owner's only power is choosing the verifier for *future* escrows. Each escrow stores its
///     verifier at creation, so rotating the key cannot affect funds already escrowed.
///   - Not upgradeable, not pausable.
///
/// Settlement paths for a Funded escrow:
///   - `executeVerdict`: anyone submits a verdict signed by the escrow's verifier, on/before the deadline
///   - `release`:        buyer pays the seller in full, any time
///   - `refund`:         seller returns the funds in full, any time
///   - `refundExpired`:  anyone, strictly after the deadline; funds go to `refundTo`
/// The deadline splits verdicts and expiry refunds into non-overlapping windows, so they never race.
///
/// Payouts are pushed; if a transfer fails (e.g. a USDC-blacklisted payee or a paused token) the
/// amount is credited to `owed` instead, so one party can never block the other's payout.
contract UsdcEscrow is VerdictVerifier, Ownable2Step, ReentrancyGuardTransient {
    using SafeERC20 for IUSDC;

    enum Status {
        None,
        Funded,
        Released,
        Refunded,
        Resolved
    }

    /// @notice What the buyer agrees to. Hashed (with the buyer) into the escrow id.
    struct Terms {
        address seller;
        address refundTo;
        address verifier;
        uint256 amount;
        uint64 deadline;
        bytes32 salt;
    }

    struct Escrow {
        address buyer;
        address seller;
        address refundTo;
        address verifier;
        uint64 deadline;
        Status status;
        uint256 amount;
    }

    IUSDC public immutable usdc;

    /// @notice Verifier required for newly created escrows.
    address public verifier;

    /// @notice USDC credited to an account whose push payment failed.
    mapping(address => uint256) public owed;

    mapping(bytes32 => Escrow) internal _escrows;

    event EscrowCreated(
        bytes32 indexed id,
        address indexed buyer,
        address indexed seller,
        address refundTo,
        address verifier,
        uint256 amount,
        uint64 deadline
    );
    event Released(bytes32 indexed id, uint256 amount);
    event Refunded(bytes32 indexed id, uint256 amount);
    event VerdictExecuted(bytes32 indexed id, uint256 toSeller, uint256 toBuyer);
    event PaymentDeferred(address indexed account, uint256 amount);
    event Withdrawn(address indexed account, uint256 amount);
    event VerifierUpdated(address indexed previous, address indexed current);

    error ZeroAddress();
    error InvalidParties();
    error ZeroAmount();
    error DeadlineInPast();
    error WrongVerifier();
    error EscrowExists();
    error NotFunded();
    error NotAuthorized();
    error DeadlinePassed();
    error DeadlineNotReached();
    error AmountExceedsEscrow();
    error UnexpectedAmountReceived();
    error NothingOwed();

    constructor(IUSDC _usdc, address _verifier, address _owner) EIP712("UsdcEscrow", "1") Ownable(_owner) {
        if (address(_usdc) == address(0) || _verifier == address(0)) revert ZeroAddress();
        usdc = _usdc;
        verifier = _verifier;
        emit VerifierUpdated(address(0), _verifier);
    }

    // ---------------------------------------------------------------------
    // Funding
    // ---------------------------------------------------------------------

    /// @notice Fund an escrow from msg.sender using a prior USDC approval.
    function createEscrow(Terms calldata terms) external nonReentrant returns (bytes32 id) {
        id = _open(msg.sender, terms);
        uint256 balanceBefore = usdc.balanceOf(address(this));
        usdc.safeTransferFrom(msg.sender, address(this), terms.amount);
        _checkReceived(balanceBefore, terms.amount);
    }

    /// @notice Fund an escrow with the buyer's EIP-3009 `ReceiveWithAuthorization` signature.
    /// Anyone (relayer, bundler, the agent itself) may submit it.
    /// @dev The authorization nonce must equal `computeEscrowId(buyer, terms)`. That binds the
    /// signature to these exact terms: a submitter cannot change seller, refundTo, verifier or deadline.
    function createEscrowWithAuthorization(
        address buyer,
        Terms calldata terms,
        uint256 validAfter,
        uint256 validBefore,
        bytes calldata signature
    ) external nonReentrant returns (bytes32 id) {
        id = _open(buyer, terms);
        uint256 balanceBefore = usdc.balanceOf(address(this));
        usdc.receiveWithAuthorization(buyer, address(this), terms.amount, validAfter, validBefore, id, signature);
        _checkReceived(balanceBefore, terms.amount);
    }

    // ---------------------------------------------------------------------
    // Settlement
    // ---------------------------------------------------------------------

    /// @notice Settle with a verdict signed by the escrow's verifier. Callable by anyone.
    function executeVerdict(bytes32 id, uint256 toSeller, uint64 expiry, bytes calldata signature)
        external
        nonReentrant
    {
        Escrow storage e = _funded(id);
        if (block.timestamp > e.deadline) revert DeadlinePassed();
        if (toSeller > e.amount) revert AmountExceedsEscrow();
        _verifyVerdict(e.verifier, id, toSeller, expiry, signature);

        uint256 toBuyer = e.amount - toSeller;
        e.status = Status.Resolved;
        // forge-lint: disable-next-line(reentrancy-events) -- only prior call is a staticcall to the verifier
        emit VerdictExecuted(id, toSeller, toBuyer);

        _pay(e.seller, toSeller);
        _pay(e.refundTo, toBuyer);
    }

    /// @notice Buyer pays the seller in full.
    function release(bytes32 id) external nonReentrant {
        Escrow storage e = _funded(id);
        if (msg.sender != e.buyer) revert NotAuthorized();

        e.status = Status.Released;
        emit Released(id, e.amount);
        _pay(e.seller, e.amount);
    }

    /// @notice Seller returns the funds in full.
    function refund(bytes32 id) external nonReentrant {
        Escrow storage e = _funded(id);
        if (msg.sender != e.seller) revert NotAuthorized();
        _refund(id, e);
    }

    /// @notice After the deadline, anyone can return the funds to `refundTo`. Needs no operator.
    function refundExpired(bytes32 id) external nonReentrant {
        Escrow storage e = _funded(id);
        if (block.timestamp <= e.deadline) revert DeadlineNotReached();
        _refund(id, e);
    }

    /// @notice Pay out a deferred balance. Anyone may trigger it; funds only go to `account`.
    function withdraw(address account) external nonReentrant {
        uint256 amount = owed[account];
        if (amount == 0) revert NothingOwed();

        owed[account] = 0;
        emit Withdrawn(account, amount);
        usdc.safeTransfer(account, amount);
    }

    // ---------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------

    /// @notice Set the verifier for escrows created from now on. Existing escrows are unaffected.
    function setVerifier(address newVerifier) external onlyOwner {
        if (newVerifier == address(0)) revert ZeroAddress();
        emit VerifierUpdated(verifier, newVerifier);
        verifier = newVerifier;
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function computeEscrowId(address buyer, Terms calldata terms) public pure returns (bytes32) {
        return keccak256(abi.encode(buyer, terms));
    }

    function getEscrow(bytes32 id) external view returns (Escrow memory) {
        return _escrows[id];
    }

    // ---------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------

    function _open(address buyer, Terms calldata t) private returns (bytes32 id) {
        if (buyer == address(0) || t.seller == address(0) || t.refundTo == address(0)) revert ZeroAddress();
        if (t.seller == buyer || t.seller == t.refundTo) revert InvalidParties();
        if (t.verifier != verifier) revert WrongVerifier();
        if (t.amount == 0) revert ZeroAmount();
        if (t.deadline <= block.timestamp) revert DeadlineInPast();

        id = computeEscrowId(buyer, t);
        if (_escrows[id].status != Status.None) revert EscrowExists();

        _escrows[id] = Escrow({
            buyer: buyer,
            seller: t.seller,
            refundTo: t.refundTo,
            verifier: t.verifier,
            deadline: t.deadline,
            status: Status.Funded,
            amount: t.amount
        });
        emit EscrowCreated(id, buyer, t.seller, t.refundTo, t.verifier, t.amount, t.deadline);
    }

    function _funded(bytes32 id) private view returns (Escrow storage e) {
        e = _escrows[id];
        if (e.status != Status.Funded) revert NotFunded();
    }

    function _refund(bytes32 id, Escrow storage e) private {
        e.status = Status.Refunded;
        emit Refunded(id, e.amount);
        _pay(e.refundTo, e.amount);
    }

    function _pay(address to, uint256 amount) private {
        if (amount == 0) return;
        if (!usdc.trySafeTransfer(to, amount)) {
            owed[to] += amount;
            // forge-lint: disable-next-line(reentrancy-events) -- the failed transfer is what triggers this event
            emit PaymentDeferred(to, amount);
        }
    }

    /// @dev Guards against a future USDC upgrade introducing transfer fees.
    function _checkReceived(uint256 balanceBefore, uint256 amount) private view {
        // forge-lint: disable-next-line(incorrect-strict-equality) -- exact amount is the point
        if (usdc.balanceOf(address(this)) - balanceBefore != amount) revert UnexpectedAmountReceived();
    }
}
