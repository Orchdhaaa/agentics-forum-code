// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title Agentics Blue Tick NFT
/// @notice Blue Tick as a soulbound (non-transferable) ERC-721 on BNB Smart
/// Chain. $5 per year, paid as 5 USDT (BSC) to the treasury. The tick is
/// bound to the holder's Agent ID handle: it cannot be transferred, so the
/// benefit can never move to another wallet/handle.
///
/// EXPIRY (on-chain, not offchain):
/// - Every token carries `expiresAt`. `isActive(tokenId)` is true only
///   while `block.timestamp < expiresAt`. `balanceOf` alone is NOT enough:
///   an expired token still sits in the wallet but gives no benefit; the
///   backend and frontend must check `isActive` / `activeBalanceOf`.
/// - Expired tokens are NOT burned. They stay in the wallet as a record
///   and can be renewed. There is no permissionless burn: burning would
///   only let the owner mint a fresh token, which renewal already covers.
/// - RENEWAL extends the SAME token, never mints a new one: one
///   wallet/handle = one token for life. `renew(tokenId, ...)` sets
///   `expiresAt = max(oldExpiresAt, now) + durationDays`. Active tokens
///   extend from the old expiry (early renewal loses nothing); expired
///   tokens restart from the renewal time (a lapse is not backdated).
/// - Only the token owner may renew it.
///
/// PRICE / VOUCHERS (unchanged from the offchain system):
/// - Full price is 5 USDT (5_000_000 base units, 6 decimals), 365 days.
/// - Discount/free vouchers are enforced by the BACKEND (vouchers.js),
///   never by this contract. The backend signs an EIP-712 authorization
///   for (buyer, amount, durationDays, voucherCode, deadline, nonce);
///   this contract only checks that the signature came from AUTHORIZER.
///   A free voucher mints at amount 0; a discount voucher mints at the
///   backend-computed discounted price. Plain full-price buys need no
///   signature. The contract never sees voucher rules, so the old rules
///   (kinds, percent/fixed discounts, maxUses, 24h handle rule) apply
///   exactly as before.
/// - CONFLICT NOTE (documented, rules win): a free voucher used to grant
///   the tick with zero gas (offchain). As an NFT the user still pays gas
///   for the mint/renew transaction itself; the voucher only waives the
///   $5 price. The price/discount rules themselves are unchanged.
///
/// No owner, no admin functions, no pausing. USDT is forwarded straight
/// to the treasury; the contract never holds funds. Not deployed yet:
/// deploy needs the operator's gas approval first.
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

contract BlueTickNFT is ERC721, EIP712 {
    using ECDSA for bytes32;

    address public immutable USDT;
    address public immutable TREASURY;
    address public immutable AUTHORIZER;

    /// @notice Full price: 5 USDT, 6 decimals.
    uint256 public constant PRICE = 5_000_000;
    /// @notice Default validity of one purchase: 365 days.
    uint256 public constant DEFAULT_DURATION_DAYS = 365;
    uint256 public constant MIN_DURATION_DAYS = 1;
    uint256 public constant MAX_DURATION_DAYS = 3650;

    bytes32 private constant PURCHASE_TYPEHASH = keccak256(
        "Purchase(address buyer,uint256 amount,uint256 durationDays,bytes32 voucherCodeHash,uint256 deadline,uint256 nonce)"
    );

    uint256 public nextTokenId;
    mapping(uint256 => uint256) public expiresAt;
    mapping(address => uint256) public tokenOf;
    mapping(uint256 => bool) public usedNonces;

    event BlueTickMinted(
        uint256 indexed tokenId,
        address indexed buyer,
        uint256 amount,
        string voucherCode,
        uint256 expiresAt
    );
    event BlueTickRenewed(
        uint256 indexed tokenId,
        address indexed owner,
        uint256 newExpiresAt,
        uint256 amount,
        string voucherCode
    );

    constructor(address _usdt, address _treasury, address _authorizer)
        ERC721("Agentics Blue Tick", "ABT")
        EIP712("Agentics Blue Tick", "1")
    {
        require(_usdt != address(0), "usdt zero");
        require(_treasury != address(0), "treasury zero");
        require(_authorizer != address(0), "authorizer zero");
        USDT = _usdt;
        TREASURY = _treasury;
        AUTHORIZER = _authorizer;
    }

    /// @notice Soulbound: transfers are blocked. Only minting (from == 0)
    /// is allowed. Approvals are inert and also blocked for clarity.
    function _update(address to, uint256 tokenId, address auth)
        internal
        override
        returns (address)
    {
        address from = _ownerOf(tokenId);
        require(from == address(0), "soulbound: non-transferable");
        return super._update(to, tokenId, auth);
    }

    function approve(address, uint256) public pure override {
        revert("soulbound: non-transferable");
    }

    function setApprovalForAll(address, bool) public pure override {
        revert("soulbound: non-transferable");
    }

    /// @notice True while the token exists and has not expired.
    function isActive(uint256 tokenId) public view returns (bool) {
        return _ownerOf(tokenId) != address(0) && block.timestamp < expiresAt[tokenId];
    }

    /// @notice True when the token exists but its validity has passed.
    function isExpired(uint256 tokenId) public view returns (bool) {
        return _ownerOf(tokenId) != address(0) && block.timestamp >= expiresAt[tokenId];
    }

    /// @notice 1 when the address holds an active (unexpired) tick, else 0.
    /// This is the check the backend and frontend must use for benefits.
    function activeBalanceOf(address owner) public view returns (uint256) {
        uint256 tokenId = tokenOf[owner];
        if (tokenId == 0) return 0;
        return isActive(tokenId) ? 1 : 0;
    }

    function expiresAtOf(uint256 tokenId) public view returns (uint256) {
        return expiresAt[tokenId];
    }

    function _verifyPurchaseAuth(
        address buyer,
        uint256 amount,
        uint256 durationDays,
        string calldata voucherCode,
        uint256 deadline,
        uint256 nonce,
        bytes calldata auth
    ) internal {
        require(block.timestamp <= deadline, "auth expired");
        require(!usedNonces[nonce], "nonce used");
        bytes32 digest = _hashTypedDataV4(
            keccak256(
                abi.encode(
                    PURCHASE_TYPEHASH,
                    buyer,
                    amount,
                    durationDays,
                    keccak256(bytes(voucherCode)),
                    deadline,
                    nonce
                )
            )
        );
        require(digest.recover(auth) == AUTHORIZER, "bad auth");
        usedNonces[nonce] = true;
    }

    function _charge(uint256 amount) internal {
        if (amount == 0) return;
        require(
            IERC20(USDT).transferFrom(msg.sender, TREASURY, amount),
            "usdt transfer failed"
        );
    }

    /// @notice Buy a Blue Tick (mint). One token per wallet, forever.
    /// @param amount USDT in base units (6 decimals). Full price is
    ///  PRICE (5_000_000); 0 for a free voucher; discounted price for a
    ///  discount voucher.
    /// @param durationDays Validity granted. 365 for a plain purchase;
    ///  voucher days when a voucher is used.
    /// @param voucherCode "" for a plain purchase, else the voucher code.
    ///  Plain purchases (amount == PRICE, no voucher, 365 days) need no
    ///  signature; anything else needs a backend authorization.
    function buy(
        uint256 amount,
        uint256 durationDays,
        string calldata voucherCode,
        uint256 deadline,
        uint256 nonce,
        bytes calldata auth
    ) external returns (uint256 tokenId) {
        require(tokenOf[msg.sender] == 0, "already owns a tick");
        require(
            durationDays >= MIN_DURATION_DAYS && durationDays <= MAX_DURATION_DAYS,
            "bad duration"
        );
        bool plain = bytes(voucherCode).length == 0 &&
            amount == PRICE &&
            durationDays == DEFAULT_DURATION_DAYS;
        if (!plain) {
            _verifyPurchaseAuth(
                msg.sender,
                amount,
                durationDays,
                voucherCode,
                deadline,
                nonce,
                auth
            );
        }
        _charge(amount);
        tokenId = ++nextTokenId;
        expiresAt[tokenId] = block.timestamp + durationDays * 1 days;
        tokenOf[msg.sender] = tokenId;
        _safeMint(msg.sender, tokenId);
        emit BlueTickMinted(
            tokenId,
            msg.sender,
            amount,
            voucherCode,
            expiresAt[tokenId]
        );
    }

    /// @notice Renew the SAME token. Never mints a new one.
    /// Expiry extends from the old expiry when still active, otherwise
    /// from now: `max(oldExpiresAt, now) + durationDays`.
    /// Only the token owner may call it.
    function renew(
        uint256 tokenId,
        uint256 amount,
        uint256 durationDays,
        string calldata voucherCode,
        uint256 deadline,
        uint256 nonce,
        bytes calldata auth
    ) external {
        require(_ownerOf(tokenId) == msg.sender, "not token owner");
        require(
            durationDays >= MIN_DURATION_DAYS && durationDays <= MAX_DURATION_DAYS,
            "bad duration"
        );
        bool plain = bytes(voucherCode).length == 0 &&
            amount == PRICE &&
            durationDays == DEFAULT_DURATION_DAYS;
        if (!plain) {
            _verifyPurchaseAuth(
                msg.sender,
                amount,
                durationDays,
                voucherCode,
                deadline,
                nonce,
                auth
            );
        }
        _charge(amount);
        uint256 base = expiresAt[tokenId] > block.timestamp
            ? expiresAt[tokenId]
            : block.timestamp;
        expiresAt[tokenId] = base + durationDays * 1 days;
        emit BlueTickRenewed(
            tokenId,
            msg.sender,
            expiresAt[tokenId],
            amount,
            voucherCode
        );
    }

    /// @notice Minimal on-chain metadata: name, description and expiry.
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        require(_ownerOf(tokenId) != address(0), "no such token");
        return
            string(
                abi.encodePacked(
                    "data:application/json,{",
                    '"name":"Agentics Blue Tick #',
                    _toString(tokenId),
                    '",',
                    '"description":"Paid verification for agentics.forum. $5 per year. Soulbound to the holder Agent ID.",',
                    '"expiresAt":',
                    _toString(expiresAt[tokenId]),
                    "}"
                )
            );
    }

    function _toString(uint256 v) internal pure returns (string memory) {
        if (v == 0) return "0";
        uint256 digits;
        uint256 x = v;
        while (x > 0) {
            digits++;
            x /= 10;
        }
        bytes memory buf = new bytes(digits);
        while (v > 0) {
            digits--;
            buf[digits] = bytes1(uint8(48 + (v % 10)));
            v /= 10;
        }
        return string(buf);
    }
}
