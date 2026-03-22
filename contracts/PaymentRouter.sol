// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title PaymentRouter
 * @notice Routes USDC payments on Arc Testnet with agent-controlled execution,
 *         fee tracking, and crosschain payout support via CCTP.
 * @dev Integrates with Arc's native USDC (ERC-20 interface) and records
 *      reputation data back to the ERC-8004 ReputationRegistry.
 */

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface IReputationRegistry {
    function giveFeedback(
        uint256 agentId,
        int128 score,
        uint8 feedbackType,
        string calldata tag,
        string calldata title,
        string calldata description,
        string calldata evidenceURI,
        bytes32 feedbackHash
    ) external;
}

interface ITokenMessengerV2 {
    function depositForBurn(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32 minFinalityThreshold
    ) external returns (uint64 nonce);
}

contract PaymentRouter {

    // ─── Constants ───────────────────────────────────────────────────────────

    /// @notice Arc Testnet USDC ERC-20 interface (6 decimals)
    address public constant USDC = 0x3600000000000000000000000000000000000000;

    /// @notice Arc Testnet CCTP TokenMessengerV2
    address public constant CCTP_MESSENGER = 0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA;

    /// @notice ERC-8004 ReputationRegistry
    address public constant REPUTATION_REGISTRY = 0x8004B663056A597Dffe9eCcC1965A193B7388713;

    /// @notice Protocol fee: 0.1% (10 basis points)
    uint256 public constant FEE_BPS = 10;
    uint256 public constant BPS_DENOM = 10_000;

    // ─── State ───────────────────────────────────────────────────────────────

    address public owner;
    address public agent;        // the ERC-8004 AI agent wallet
    uint256 public agentId;      // ERC-8004 token ID
    uint256 public feeBalance;   // accumulated protocol fees (USDC)

    uint256 public totalPayments;
    uint256 public totalVolume;  // in USDC (6 decimals)
    uint256 public successCount;

    mapping(address => uint256) public senderVolume;
    mapping(bytes32 => Payment) public payments;

    struct Payment {
        address sender;
        address recipient;
        uint256 amount;
        uint256 fee;
        uint256 timestamp;
        PaymentType pType;
        bool settled;
    }

    enum PaymentType { Direct, Crosschain, AgentRouted }

    // ─── Events ──────────────────────────────────────────────────────────────

    event PaymentSent(
        bytes32 indexed paymentId,
        address indexed sender,
        address indexed recipient,
        uint256 amount,
        uint256 fee,
        PaymentType pType
    );

    event CrosschainInitiated(
        bytes32 indexed paymentId,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        uint256 amount,
        uint64 nonce
    );

    event AgentUpdated(address indexed newAgent, uint256 newAgentId);
    event FeesWithdrawn(address indexed to, uint256 amount);
    event ReputationRecorded(uint256 indexed agentId, int128 score, string tag);

    // ─── Modifiers ───────────────────────────────────────────────────────────

    modifier onlyOwner() {
        require(msg.sender == owner, "PaymentRouter: not owner");
        _;
    }

    modifier onlyAgent() {
        require(msg.sender == agent || msg.sender == owner, "PaymentRouter: not agent");
        _;
    }

    // ─── Constructor ─────────────────────────────────────────────────────────

    constructor(address _agent, uint256 _agentId) {
        owner = msg.sender;
        agent = _agent;
        agentId = _agentId;
    }

    // ─── Core: Direct Payment ────────────────────────────────────────────────

    /**
     * @notice Send a direct USDC payment to a recipient on Arc.
     * @param recipient  The address receiving USDC.
     * @param amount     Amount in USDC (6 decimals).
     * @param memo       Optional reference string (hashed into paymentId).
     */
    function sendPayment(
        address recipient,
        uint256 amount,
        string calldata memo
    ) external returns (bytes32 paymentId) {
        require(recipient != address(0), "PaymentRouter: zero recipient");
        require(amount > 0, "PaymentRouter: zero amount");

        uint256 fee = (amount * FEE_BPS) / BPS_DENOM;
        uint256 netAmount = amount - fee;

        paymentId = keccak256(abi.encodePacked(
            msg.sender, recipient, amount, block.timestamp, memo
        ));

        IERC20(USDC).transferFrom(msg.sender, address(this), amount);
        IERC20(USDC).transfer(recipient, netAmount);

        feeBalance += fee;
        totalPayments++;
        totalVolume += amount;
        successCount++;
        senderVolume[msg.sender] += amount;

        payments[paymentId] = Payment({
            sender:    msg.sender,
            recipient: recipient,
            amount:    amount,
            fee:       fee,
            timestamp: block.timestamp,
            pType:     PaymentType.Direct,
            settled:   true
        });

        emit PaymentSent(paymentId, msg.sender, recipient, amount, fee, PaymentType.Direct);

        _recordReputation(95, "successful_payment");
    }

    // ─── Core: Crosschain via CCTP ────────────────────────────────────────────

    /**
     * @notice Initiate a crosschain USDC transfer via Circle CCTP.
     * @param amount              Amount in USDC (6 decimals).
     * @param destinationDomain   CCTP domain ID of destination chain.
     * @param mintRecipient       Recipient address as bytes32 on destination.
     * @param maxFee              Max fee for CCTP (use 0 for auto).
     */
    function sendCrosschain(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        uint256 maxFee
    ) external returns (bytes32 paymentId) {
        require(amount > 0, "PaymentRouter: zero amount");

        uint256 fee = (amount * FEE_BPS) / BPS_DENOM;
        uint256 bridgeAmount = amount - fee;

        paymentId = keccak256(abi.encodePacked(
            msg.sender, destinationDomain, mintRecipient, amount, block.timestamp
        ));

        IERC20(USDC).transferFrom(msg.sender, address(this), amount);
        feeBalance += fee;

        IERC20(USDC).approve(CCTP_MESSENGER, bridgeAmount);

        uint64 nonce = ITokenMessengerV2(CCTP_MESSENGER).depositForBurn(
            bridgeAmount,
            destinationDomain,
            mintRecipient,
            USDC,
            bytes32(0),
            maxFee,
            1000  // minFinalityThreshold
        );

        totalPayments++;
        totalVolume += amount;
        successCount++;

        payments[paymentId] = Payment({
            sender:    msg.sender,
            recipient: address(0),   // offchain recipient
            amount:    amount,
            fee:       fee,
            timestamp: block.timestamp,
            pType:     PaymentType.Crosschain,
            settled:   true
        });

        emit PaymentSent(paymentId, msg.sender, address(0), amount, fee, PaymentType.Crosschain);
        emit CrosschainInitiated(paymentId, destinationDomain, mintRecipient, bridgeAmount, nonce);

        _recordReputation(92, "crosschain_payment");
    }

    // ─── Core: Agent-Routed Payment ──────────────────────────────────────────

    /**
     * @notice Agent autonomously routes a payment on behalf of the protocol.
     *         Only callable by the registered ERC-8004 agent or owner.
     * @param sender     Original payer (must have pre-approved this contract).
     * @param recipient  Destination address.
     * @param amount     USDC amount (6 decimals).
     */
    function agentRoute(
        address sender,
        address recipient,
        uint256 amount
    ) external onlyAgent returns (bytes32 paymentId) {
        require(recipient != address(0), "PaymentRouter: zero recipient");
        require(amount > 0, "PaymentRouter: zero amount");

        uint256 fee = (amount * FEE_BPS) / BPS_DENOM;
        uint256 netAmount = amount - fee;

        paymentId = keccak256(abi.encodePacked(
            sender, recipient, amount, block.timestamp, "agent"
        ));

        IERC20(USDC).transferFrom(sender, address(this), amount);
        IERC20(USDC).transfer(recipient, netAmount);

        feeBalance += fee;
        totalPayments++;
        totalVolume += amount;
        successCount++;
        senderVolume[sender] += amount;

        payments[paymentId] = Payment({
            sender:    sender,
            recipient: recipient,
            amount:    amount,
            fee:       fee,
            timestamp: block.timestamp,
            pType:     PaymentType.AgentRouted,
            settled:   true
        });

        emit PaymentSent(paymentId, sender, recipient, amount, fee, PaymentType.AgentRouted);
        _recordReputation(97, "agent_routed_payment");
    }

    // ─── Reputation ──────────────────────────────────────────────────────────

    /**
     * @dev Records a reputation event to the ERC-8004 ReputationRegistry.
     *      Called internally after each successful payment.
     */
    function _recordReputation(int128 score, string memory tag) internal {
        if (agentId == 0) return;

        bytes32 feedbackHash = keccak256(abi.encodePacked(tag, block.timestamp));

        try IReputationRegistry(REPUTATION_REGISTRY).giveFeedback(
            agentId,
            score,
            0,
            tag,
            "",
            "",
            "",
            feedbackHash
        ) {
            emit ReputationRecorded(agentId, score, tag);
        } catch {
            // Non-blocking — payment succeeds even if reputation call fails
        }
    }

    // ─── Admin ───────────────────────────────────────────────────────────────

    function setAgent(address _agent, uint256 _agentId) external onlyOwner {
        agent = _agent;
        agentId = _agentId;
        emit AgentUpdated(_agent, _agentId);
    }

    function withdrawFees(address to) external onlyOwner {
        uint256 amount = feeBalance;
        feeBalance = 0;
        IERC20(USDC).transfer(to, amount);
        emit FeesWithdrawn(to, amount);
    }

    // ─── Views ───────────────────────────────────────────────────────────────

    function getPayment(bytes32 paymentId) external view returns (Payment memory) {
        return payments[paymentId];
    }

    function getStats() external view returns (
        uint256 _totalPayments,
        uint256 _totalVolume,
        uint256 _successCount,
        uint256 _feeBalance
    ) {
        return (totalPayments, totalVolume, successCount, feeBalance);
    }

    function successRate() external view returns (uint256) {
        if (totalPayments == 0) return 0;
        return (successCount * 100) / totalPayments;
    }
}
