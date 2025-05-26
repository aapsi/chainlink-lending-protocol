// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @notice Custom errors
 */
error InvalidPriceData();
error PriceDataStale();
error MustDepositCollateral();
error NoCollateralDeposited();
error ExceedsBorrowingLimit();
error TransferFailed();
error NoActiveLoan();
error AmountExceedsDebt();
error InsufficientCollateral();
error OutstandingDebtExists();
error LoanNotLiquidatable();
error DebtTransferFailed();


/**
 * @title BTCLendingProtocol
 * @notice A simple BTC-backed lending protocol on RSK Testnet
 */
contract BTCLendingProtocol is ReentrancyGuard, Ownable {
    AggregatorV3Interface internal priceFeed;
    IERC20 public usdToken;
    uint256 public constant LIQUIDATION_THRESHOLD = 75; // 75% LTV
    uint256 public constant MAX_LTV = 70; // 70% max loan-to-value
    uint256 public constant LIQUIDATION_PENALTY = 10; // 10% penalty
    uint256 public constant PRECISION = 100; // 100% precision
    
    /**
     * @notice Loan struct
     * @dev Stores loan information
     */
    struct Loan {
        uint256 collateralAmount; // RBTC amount in wei
        uint256 borrowedAmount;   // USD amount borrowed
        uint256 timestamp;        // When loan was created
        bool active;             // Is loan active
    }
    
    /**
     * @notice Mapping of user addresses to their loan information
     */
    mapping(address => Loan) public loans;

    /**
     * @notice Total collateral deposited
     */
    uint256 public totalCollateral;

    /**
     * @notice Total borrowed amount
     */
    uint256 public totalBorrowed;
    
    /**
     * @notice Emitted when collateral is deposited
     */
    event CollateralDeposited(address indexed user, uint256 amount);
    event LoanTaken(address indexed user, uint256 collateral, uint256 borrowed);
    event LoanRepaid(address indexed user, uint256 amount);
    event CollateralWithdrawn(address indexed user, uint256 amount);
    event Liquidation(address indexed user, address indexed liquidator, uint256 collateral, uint256 debt);
    
    /**
     * @notice Constructor
     * @param _usdToken The address of the USD token
     */
    constructor(address _usdToken) Ownable(msg.sender) {
        // BTC/USD Price Feed on RSK Testnet
        priceFeed = AggregatorV3Interface(0x5741306c21795FdCBb9b265Ea0255F499DFe515C);
        usdToken = IERC20(_usdToken);
    }
    
    /**
     * @notice Allow contract to receive ETH
     */
    receive() external payable {}
    
    /**
     * @notice Get latest BTC/USD price from Chainlink
     * @return price The latest BTC/USD price
     * @return decimals The number of decimals for the price
     */
    function getLatestPrice() public view returns (int256, uint256) {
        (
            ,
            int256 price,
            ,
            uint256 updatedAt,
        ) = priceFeed.latestRoundData();
        
        if (price <= 0) revert InvalidPriceData();
        if (block.timestamp - updatedAt >= 3600) revert PriceDataStale();
        
        return (price, priceFeed.decimals());
    }
    
    /**
     * @notice Convert RBTC amount to USD value
     * @param _btcAmount The amount of RBTC to convert
     * @return usdValue The USD value of the RBTC amount
     */
    function btcToUSD(uint256 _btcAmount) public view returns (uint256) {
        (int256 price, uint256 decimals) = getLatestPrice();
        
        // Convert BTC amount (18 decimals) to USD (18 decimals)
        // Price has 'decimals' decimals, so we need to adjust
        uint256 usdValue = (_btcAmount * uint256(price)) / (10**decimals);
        
        return usdValue;
    }
    
    /**
     * @notice Calculate maximum borrowable amount based on collateral
     * @param _collateralAmount The amount of RBTC collateral
     * @return maxBorrow The maximum borrowable amount
     */
    function getMaxBorrowAmount(uint256 _collateralAmount) public view returns (uint256) {
        uint256 collateralValueUSD = btcToUSD(_collateralAmount);
        return (collateralValueUSD * MAX_LTV) / PRECISION;
    }
    
    /**
     * @notice Calculate current loan-to-value ratio
     * @param _user The address of the user
     * @return ltv The loan-to-value ratio
     */
    function getLoanToValue(address _user) public view returns (uint256) {
        Loan memory loan = loans[_user];
        if (loan.collateralAmount == 0) return 0;
        
        uint256 collateralValueUSD = btcToUSD(loan.collateralAmount);
        return (loan.borrowedAmount * PRECISION) / collateralValueUSD;
    }
    
    /**
     * @notice Check if a loan is eligible for liquidation
     * @param _user The address of the user
     * @return isLiquidatable True if the loan is eligible for liquidation
     */
    function isLiquidatable(address _user) public view returns (bool) {
        return getLoanToValue(_user) >= LIQUIDATION_THRESHOLD;
    }
    
    /**
     * @notice Deposit RBTC as collateral
     */
    function depositCollateral() external payable nonReentrant {
        if (msg.value == 0) revert MustDepositCollateral();
        
        loans[msg.sender].collateralAmount += msg.value;
        totalCollateral += msg.value;
        
        emit CollateralDeposited(msg.sender, msg.value);
    }
    
    /**
     * @notice Borrow USD against RBTC collateral
     * @param _amount The amount of USD to borrow
     */
    function borrow(uint256 _amount) external nonReentrant {
        Loan storage loan = loans[msg.sender];
        if (loan.collateralAmount == 0) revert NoCollateralDeposited();
        
        uint256 maxBorrow = getMaxBorrowAmount(loan.collateralAmount);
        if (loan.borrowedAmount + _amount > maxBorrow) revert ExceedsBorrowingLimit();
        
        loan.borrowedAmount += _amount;
        if (!loan.active) {
            loan.active = true;
            loan.timestamp = block.timestamp;
        }
        totalBorrowed += _amount;
        
        // Transfer USD tokens to borrower
        if (!usdToken.transfer(msg.sender, _amount)) revert TransferFailed();
        
        emit LoanTaken(msg.sender, loan.collateralAmount, _amount);
    }
    
    /**
     * @notice Repay borrowed USD
     * @param _amount The amount of USD to repay
     */
    function repay(uint256 _amount) external nonReentrant {
        Loan storage loan = loans[msg.sender];
        if (!loan.active) revert NoActiveLoan();
        if (_amount > loan.borrowedAmount) revert AmountExceedsDebt();
        
        // Transfer USD tokens from borrower
        if (!usdToken.transferFrom(msg.sender, address(this), _amount)) revert TransferFailed();
        
        loan.borrowedAmount -= _amount;
        totalBorrowed -= _amount;
        
        if (loan.borrowedAmount == 0) {
            loan.active = false;
        }
        
        emit LoanRepaid(msg.sender, _amount);
    }
    
    /**
     * @notice Withdraw collateral (only if no outstanding debt)
     * @param _amount The amount of RBTC to withdraw
     */
    function withdrawCollateral(uint256 _amount) external nonReentrant {
        Loan storage loan = loans[msg.sender];
        if (loan.collateralAmount < _amount) revert InsufficientCollateral();
        if (loan.borrowedAmount > 0) revert OutstandingDebtExists();
        
        loan.collateralAmount -= _amount;
        totalCollateral -= _amount;
        
        payable(msg.sender).transfer(_amount);
        
        emit CollateralWithdrawn(msg.sender, _amount);
    }
    
    /**
     * @notice Liquidate an undercollateralized loan
     * @param _user The address of the user to liquidate
     */
    function liquidate(address _user) external nonReentrant {
        if (!isLiquidatable(_user)) revert LoanNotLiquidatable();
        
        Loan storage loan = loans[_user];
        uint256 debtAmount = loan.borrowedAmount;
        uint256 collateralAmount = loan.collateralAmount;
        
        // Calculate liquidation amounts
        uint256 penaltyAmount = (collateralAmount * LIQUIDATION_PENALTY) / PRECISION;
        
        // Transfer debt from liquidator to protocol
        if (!usdToken.transferFrom(msg.sender, address(this), debtAmount)) revert DebtTransferFailed();
        
        // Clear the loan
        loan.collateralAmount = 0;
        loan.borrowedAmount = 0;
        loan.active = false;
        
        totalCollateral -= collateralAmount;
        totalBorrowed -= debtAmount;
        
        // Send collateral to liquidator (minus penalty to protocol)
        payable(msg.sender).transfer(collateralAmount - penaltyAmount);
        
        emit Liquidation(_user, msg.sender, collateralAmount, debtAmount);
    }
    
    /**
     * @notice Get user's loan information
     * @param _user The address of the user
     * @return collateral The amount of RBTC collateral
     * @return borrowed The amount of USD borrowed
     * @return ltv The loan-to-value ratio
     * @return liquidatable True if the loan is eligible for liquidation
     * @return maxBorrow The maximum borrowable amount
     */
    function getUserLoan(address _user) external view returns (
        uint256 collateral,
        uint256 borrowed,
        uint256 ltv,
        bool liquidatable,
        uint256 maxBorrow
    ) {
        Loan memory loan = loans[_user];
        return (
            loan.collateralAmount,
            loan.borrowedAmount,
            getLoanToValue(_user),
            isLiquidatable(_user),
            getMaxBorrowAmount(loan.collateralAmount)
        );
    }
    
    /**
     * @notice Get protocol statistics
     * @return _totalCollateral The total amount of RBTC collateral
     * @return _totalBorrowed The total amount of USD borrowed
     * @return btcPrice The latest BTC/USD price
     * @return utilizationRate The utilization rate of the protocol
     */
    function getProtocolStats() external view returns (
        uint256 _totalCollateral,
        uint256 _totalBorrowed,
        uint256 btcPrice,
        uint256 utilizationRate
    ) {
        (int256 price,) = getLatestPrice();
        uint256 utilization = totalCollateral > 0 ? 
            (totalBorrowed * PRECISION) / btcToUSD(totalCollateral) : 0;
            
        return (
            totalCollateral,
            totalBorrowed,
            uint256(price),
            utilization
        );
    }
    
    /**
     * @notice Emergency functions for owner
     */
    function withdrawProtocolFees() external onlyOwner {
        payable(owner()).transfer(address(this).balance);
    }
    
    /**
     * @notice Update the price feed
     * @param _newPriceFeed The address of the new price feed
     */
    function updatePriceFeed(address _newPriceFeed) external onlyOwner {
        priceFeed = AggregatorV3Interface(_newPriceFeed);
    }
}