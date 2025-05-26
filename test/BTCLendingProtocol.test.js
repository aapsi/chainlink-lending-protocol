const {
  time,
  loadFixture,
} = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("BTCLendingProtocol", function () {
  // Optimized constants
  const LIQUIDATION_THRESHOLD = 75n;
  const MAX_LTV = 70n;
  const LIQUIDATION_PENALTY = 10n;
  const PRECISION = 100n;
  const MOCK_BTC_PRICE = 50000n * 10n ** 8n;
  const MOCK_DECIMALS = 8;
  const INITIAL_USD_SUPPLY = ethers.parseEther("10000000");
  const ONE_BTC = ethers.parseEther("1");
  const HALF_BTC = ethers.parseEther("0.5");

  async function deployFixture() {
    const [owner, borrower, liquidator, user2] = await ethers.getSigners();
    const [MockERC20, MockV3Aggregator, BTCLendingProtocol] = await Promise.all(
      [
        ethers.getContractFactory("MockERC20"),
        ethers.getContractFactory("MockV3Aggregator"),
        ethers.getContractFactory("BTCLendingProtocol"),
      ]
    );

    const [usd, feed] = await Promise.all([
      MockERC20.deploy("Mock USD", "mUSD", 18, INITIAL_USD_SUPPLY),
      MockV3Aggregator.deploy(MOCK_DECIMALS, MOCK_BTC_PRICE),
    ]);

    const protocol = await BTCLendingProtocol.deploy(await usd.getAddress());

    await Promise.all([
      protocol.updatePriceFeed(await feed.getAddress()),
      usd.transfer(await protocol.getAddress(), ethers.parseEther("500000")),
      usd.transfer(borrower.address, ethers.parseEther("100000")),
      usd.transfer(liquidator.address, ethers.parseEther("100000")),
      usd.transfer(user2.address, ethers.parseEther("50000")),
    ]);

    return { protocol, usd, feed, owner, borrower, liquidator, user2 };
  }

  // Helper functions for common operations
  const helpers = {
    deposit: (protocol, user, amount) =>
      protocol.connect(user).depositCollateral({ value: amount }),
    borrow: (protocol, user, amount) => protocol.connect(user).borrow(amount),
    async repay(protocol, usd, user, amount) {
      await usd.connect(user).approve(await protocol.getAddress(), amount);
      return protocol.connect(user).repay(amount);
    },
    async setupLoan(protocol, user, collateral, borrowed) {
      await this.deposit(protocol, user, collateral);
      await this.borrow(protocol, user, borrowed);
      return { collateral, borrowed };
    },
    async makeLiquidatable(protocol, feed, usd, borrower, liquidator) {
      await this.setupLoan(
        protocol,
        borrower,
        ONE_BTC,
        ethers.parseEther("30000")
      );
      await feed.updateAnswer(35000n * 10n ** 8n);
      await usd
        .connect(liquidator)
        .approve(await protocol.getAddress(), ethers.parseEther("30000"));
      return { collateral: ONE_BTC, borrowed: ethers.parseEther("30000") };
    },
  };

  describe("Core Functionality", function () {
    it("Should deploy with correct parameters", async function () {
      const { protocol, usd, owner } = await loadFixture(deployFixture);
      const [ownerAddr, usdAddr, threshold, ltv, penalty, precision] =
        await Promise.all([
          protocol.owner(),
          protocol.usdToken(),
          protocol.LIQUIDATION_THRESHOLD(),
          protocol.MAX_LTV(),
          protocol.LIQUIDATION_PENALTY(),
          protocol.PRECISION(),
        ]);

      expect(ownerAddr).to.equal(owner.address);
      expect(usdAddr).to.equal(await usd.getAddress());
      expect([threshold, ltv, penalty, precision]).to.deep.equal([
        LIQUIDATION_THRESHOLD,
        MAX_LTV,
        LIQUIDATION_PENALTY,
        PRECISION,
      ]);
    });

    it("Should handle price operations and conversions", async function () {
      const { protocol } = await loadFixture(deployFixture);
      const [[price, decimals], usdValue, maxBorrow] = await Promise.all([
        protocol.getLatestPrice(),
        protocol.btcToUSD(ONE_BTC),
        protocol.getMaxBorrowAmount(ONE_BTC),
      ]);

      expect([price, decimals]).to.deep.equal([MOCK_BTC_PRICE, MOCK_DECIMALS]);
      expect([usdValue, maxBorrow]).to.deep.equal([
        ethers.parseEther("50000"),
        ethers.parseEther("35000"),
      ]);
    });

    it("Should reject invalid price conditions", async function () {
      const { protocol, feed } = await loadFixture(deployFixture);

      await time.increase(7201); // Make stale
      await expect(protocol.getLatestPrice()).to.be.revertedWithCustomError(
        protocol,
        "PriceDataStale"
      );

      await feed.updateAnswer(0); // Invalid price
      await expect(protocol.getLatestPrice()).to.be.revertedWithCustomError(
        protocol,
        "InvalidPriceData"
      );
    });
  });

  describe("Collateral & Borrowing", function () {
    it("Should handle complete collateral lifecycle", async function () {
      const { protocol, usd, borrower } = await loadFixture(deployFixture);

      // Deposit and verify
      await expect(helpers.deposit(protocol, borrower, ONE_BTC))
        .to.emit(protocol, "CollateralDeposited")
        .withArgs(borrower.address, ONE_BTC);

      // Additional deposit
      await helpers.deposit(protocol, borrower, HALF_BTC);
      const [loan1, total1] = await Promise.all([
        protocol.loans(borrower.address),
        protocol.totalCollateral(),
      ]);
      expect([loan1.collateralAmount, total1]).to.deep.equal([
        ONE_BTC + HALF_BTC,
        ONE_BTC + HALF_BTC,
      ]);

      // Borrow against collateral
      const borrowAmount = ethers.parseEther("30000");
      await expect(helpers.borrow(protocol, borrower, borrowAmount))
        .to.emit(protocol, "LoanTaken")
        .withArgs(borrower.address, ONE_BTC + HALF_BTC, borrowAmount);

      const [loan2, totalBorrowed, ltv] = await Promise.all([
        protocol.loans(borrower.address),
        protocol.totalBorrowed(),
        protocol.getLoanToValue(borrower.address),
      ]);
      expect([
        loan2.borrowedAmount,
        loan2.active,
        totalBorrowed,
        ltv,
      ]).to.deep.equal([borrowAmount, true, borrowAmount, 40n]);

      // Repay and withdraw
      await helpers.repay(protocol, usd, borrower, borrowAmount);
      await expect(
        protocol.connect(borrower).withdrawCollateral(ONE_BTC + HALF_BTC)
      )
        .to.emit(protocol, "CollateralWithdrawn")
        .withArgs(borrower.address, ONE_BTC + HALF_BTC);

      const finalLoan = await protocol.loans(borrower.address);
      expect([
        finalLoan.collateralAmount,
        finalLoan.borrowedAmount,
        finalLoan.active,
      ]).to.deep.equal([0n, 0n, false]);
    });

    it("Should enforce all constraints", async function () {
      const { protocol, usd, borrower } = await loadFixture(deployFixture);

      // Constraint violations
      await expect(
        helpers.deposit(protocol, borrower, 0)
      ).to.be.revertedWithCustomError(protocol, "MustDepositCollateral");
      await expect(
        helpers.borrow(protocol, borrower, ONE_BTC)
      ).to.be.revertedWithCustomError(protocol, "NoCollateralDeposited");

      await helpers.deposit(protocol, borrower, ONE_BTC);
      await expect(
        helpers.borrow(protocol, borrower, ethers.parseEther("40000"))
      ).to.be.revertedWithCustomError(protocol, "ExceedsBorrowingLimit");
      await expect(
        protocol.connect(borrower).withdrawCollateral(ethers.parseEther("2"))
      ).to.be.revertedWithCustomError(protocol, "InsufficientCollateral");

      await helpers.borrow(protocol, borrower, ethers.parseEther("30000"));
      await expect(
        protocol.connect(borrower).withdrawCollateral(ONE_BTC)
      ).to.be.revertedWithCustomError(protocol, "OutstandingDebtExists");
      await expect(
        protocol.connect(borrower).repay(ethers.parseEther("40000"))
      ).to.be.revertedWithCustomError(protocol, "AmountExceedsDebt");
      await expect(
        protocol.connect(borrower).repay(ethers.parseEther("10000"))
      ).to.be.revertedWithCustomError(protocol, "TransferFailed");
    });
  });

  describe("Liquidation System", function () {
    it("Should handle liquidation mechanics", async function () {
      const { protocol, usd, feed, borrower, liquidator } = await loadFixture(
        deployFixture
      );

      const { collateral, borrowed } = await helpers.makeLiquidatable(
        protocol,
        feed,
        usd,
        borrower,
        liquidator
      );

      // Verify liquidatable state and LTV thresholds
      expect(await protocol.isLiquidatable(borrower.address)).to.be.true;
      await feed.updateAnswer(40000n * 10n ** 8n); // Exactly at threshold
      expect(await protocol.isLiquidatable(borrower.address)).to.be.true;

      // Execute liquidation
      const liquidatorBefore = await ethers.provider.getBalance(
        liquidator.address
      );
      const tx = await protocol.connect(liquidator).liquidate(borrower.address);
      const receipt = await tx.wait();
      const liquidatorAfter = await ethers.provider.getBalance(
        liquidator.address
      );

      // Verify liquidation completed and penalty applied
      const loan = await protocol.loans(borrower.address);
      expect([
        loan.collateralAmount,
        loan.borrowedAmount,
        loan.active,
      ]).to.deep.equal([0n, 0n, false]);

      const expectedCollateral = (collateral * 90n) / 100n; // 90% after penalty
      const gasUsed = receipt.gasUsed * receipt.gasPrice;
      expect(liquidatorAfter).to.be.closeTo(
        liquidatorBefore + expectedCollateral - gasUsed,
        ethers.parseEther("0.01")
      );
    });

    it("Should test isLiquidatable function with comprehensive LTV scenarios", async function () {
      const { protocol, feed, borrower } = await loadFixture(deployFixture);

      await helpers.setupLoan(
        protocol,
        borrower,
        ONE_BTC,
        ethers.parseEther("30000")
      );

      // Test healthy loan (60% LTV < 75% threshold)
      expect(await protocol.isLiquidatable(borrower.address)).to.be.false;

      // Test approaching threshold (74% LTV)
      await feed.updateAnswer(40540n * 10n ** 8n); // Makes LTV ~74%
      expect(await protocol.isLiquidatable(borrower.address)).to.be.false;

      // Test exactly at threshold (75% LTV)
      await feed.updateAnswer(40000n * 10n ** 8n); // Makes LTV exactly 75%
      expect(await protocol.isLiquidatable(borrower.address)).to.be.true;

      // Test well above threshold (85% LTV)
      await feed.updateAnswer(35294n * 10n ** 8n); // Makes LTV ~85%
      expect(await protocol.isLiquidatable(borrower.address)).to.be.true;
    });

    it("Should calculate liquidation penalty correctly with precise amounts", async function () {
      const { protocol, usd, feed, borrower, liquidator } = await loadFixture(
        deployFixture
      );
      const collateralAmount = ethers.parseEther("2"); // 2 BTC
      const borrowAmount = ethers.parseEther("60000"); // $60k

      await helpers.setupLoan(
        protocol,
        borrower,
        collateralAmount,
        borrowAmount
      );
      await feed.updateAnswer(35000n * 10n ** 8n); // Drop price for liquidation

      const borrowerEthBefore = await ethers.provider.getBalance(
        borrower.address
      );
      const liquidatorEthBefore = await ethers.provider.getBalance(
        liquidator.address
      );

      await usd
        .connect(liquidator)
        .approve(await protocol.getAddress(), borrowAmount);

      // Execute liquidation and measure penalty
      await expect(protocol.connect(liquidator).liquidate(borrower.address))
        .to.emit(protocol, "Liquidation")
        .withArgs(
          borrower.address,
          liquidator.address,
          collateralAmount,
          borrowAmount
        );

      const liquidatorEthAfter = await ethers.provider.getBalance(
        liquidator.address
      );

      // Liquidator should receive 90% of collateral (10% penalty to protocol)
      const expectedCollateralReceived = (collateralAmount * 90n) / 100n;
      const actualCollateralReceived = liquidatorEthAfter - liquidatorEthBefore;

      // Allow for gas costs in comparison
      expect(actualCollateralReceived).to.be.closeTo(
        expectedCollateralReceived,
        ethers.parseEther("0.1")
      );

      // Verify protocol received penalty
      const protocolBalance = await ethers.provider.getBalance(
        await protocol.getAddress()
      );
      const expectedPenalty = (collateralAmount * 10n) / 100n;
      expect(protocolBalance).to.be.gte(expectedPenalty);
    });

    it("Should prevent invalid liquidations", async function () {
      const { protocol, usd, borrower, liquidator } = await loadFixture(
        deployFixture
      );

      await helpers.setupLoan(
        protocol,
        borrower,
        ONE_BTC,
        ethers.parseEther("30000")
      );
      expect(await protocol.isLiquidatable(borrower.address)).to.be.false;

      await usd
        .connect(liquidator)
        .approve(await protocol.getAddress(), ethers.parseEther("30000"));
      await expect(
        protocol.connect(liquidator).liquidate(borrower.address)
      ).to.be.revertedWithCustomError(protocol, "LoanNotLiquidatable");
    });
  });

  describe("Partial Collateral Withdrawal", function () {
    it("Should allow partial collateral withdrawal when no debt", async function () {
      const { protocol, borrower } = await loadFixture(deployFixture);
      const withdrawAmount = HALF_BTC;

      await helpers.deposit(protocol, borrower, ONE_BTC);

      await expect(
        protocol.connect(borrower).withdrawCollateral(withdrawAmount)
      )
        .to.emit(protocol, "CollateralWithdrawn")
        .withArgs(borrower.address, withdrawAmount);

      const loan = await protocol.loans(borrower.address);
      expect(loan.collateralAmount).to.equal(ONE_BTC - withdrawAmount);
    });

    it("Should allow safe partial withdrawal after loan repayment", async function () {
      const { protocol, usd, borrower } = await loadFixture(deployFixture);

      // Setup and repay loan completely
      await helpers.setupLoan(
        protocol,
        borrower,
        ethers.parseEther("3"),
        ethers.parseEther("90000")
      );
      await helpers.repay(protocol, usd, borrower, ethers.parseEther("90000"));

      // Should allow partial withdrawal
      await expect(
        protocol.connect(borrower).withdrawCollateral(ethers.parseEther("1.5"))
      )
        .to.emit(protocol, "CollateralWithdrawn")
        .withArgs(borrower.address, ethers.parseEther("1.5"));

      const loan = await protocol.loans(borrower.address);
      expect(loan.collateralAmount).to.equal(ethers.parseEther("1.5"));
    });
  });

  describe("Transfer Failure Scenarios", function () {
    it("Should handle USD token transfer failures comprehensively", async function () {
      const { protocol, usd, borrower } = await loadFixture(deployFixture);

      await helpers.deposit(protocol, borrower, ONE_BTC);

      // Test borrow failure - contract insufficient balance
      const excessiveBorrow = ethers.parseEther("600000"); // More than 500k contract balance
      await expect(
        helpers.borrow(protocol, borrower, excessiveBorrow)
      ).to.be.revertedWithCustomError(protocol, "ExceedsBorrowingLimit");

      // Test repay failure - no approval
      await helpers.borrow(protocol, borrower, ethers.parseEther("30000"));
      await expect(
        protocol.connect(borrower).repay(ethers.parseEther("10000"))
      ).to.be.revertedWithCustomError(protocol, "TransferFailed");

      // Test repay failure - insufficient user balance
      await usd.connect(borrower).transfer(borrower.address, 0); // Reset to ensure known state
      const userBalance = await usd.balanceOf(borrower.address);
      await usd
        .connect(borrower)
        .approve(await protocol.getAddress(), userBalance + 1n);
      await expect(
        protocol.connect(borrower).repay(userBalance + 1n)
      ).to.be.revertedWithCustomError(protocol, "TransferFailed");
    });

    it("Should handle liquidation transfer failures", async function () {
      const { protocol, usd, feed, borrower, liquidator } = await loadFixture(
        deployFixture
      );

      await helpers.makeLiquidatable(protocol, feed, usd, borrower, liquidator);

      // Remove liquidator's approval to cause transfer failure
      await usd.connect(liquidator).approve(await protocol.getAddress(), 0);
      await expect(
        protocol.connect(liquidator).liquidate(borrower.address)
      ).to.be.revertedWithCustomError(protocol, "DebtTransferFailed");
    });
  });

  describe("Timestamp and State Validation", function () {
    it("Should set and validate timestamps correctly", async function () {
      const { protocol, usd, borrower } = await loadFixture(deployFixture);

      await helpers.deposit(protocol, borrower, ONE_BTC);

      // Capture timestamp before and after borrowing
      const beforeBorrow = await time.latest();
      await helpers.borrow(protocol, borrower, ethers.parseEther("30000"));
      const afterBorrow = await time.latest();

      const loan = await protocol.loans(borrower.address);
      expect(loan.timestamp).to.be.gte(beforeBorrow);
      expect(loan.timestamp).to.be.lte(afterBorrow);

      // Verify timestamp doesn't change on additional borrows
      const originalTimestamp = loan.timestamp;
      await helpers.borrow(protocol, borrower, ethers.parseEther("5000"));
      const updatedLoan = await protocol.loans(borrower.address);
      expect(updatedLoan.timestamp).to.equal(originalTimestamp);

      // Verify state transitions with timestamps
      await helpers.repay(protocol, usd, borrower, ethers.parseEther("35000"));
      const finalLoan = await protocol.loans(borrower.address);
      expect(finalLoan.active).to.be.false;
      expect(finalLoan.timestamp).to.equal(originalTimestamp); // Timestamp preserved
    });

    it("Should handle complete state transition lifecycle", async function () {
      const { protocol, usd, borrower } = await loadFixture(deployFixture);

      // Initial state - no loan
      let loan = await protocol.loans(borrower.address);
      expect([
        loan.active,
        loan.borrowedAmount,
        loan.collateralAmount,
        loan.timestamp,
      ]).to.deep.equal([false, 0n, 0n, 0n]);

      // After deposit - still no active loan
      await helpers.deposit(protocol, borrower, ONE_BTC);
      loan = await protocol.loans(borrower.address);
      expect([
        loan.active,
        loan.borrowedAmount > 0n,
        loan.collateralAmount > 0n,
      ]).to.deep.equal([false, false, true]);

      // After borrow - active loan
      await helpers.borrow(protocol, borrower, ethers.parseEther("30000"));
      loan = await protocol.loans(borrower.address);
      expect([
        loan.active,
        loan.borrowedAmount > 0n,
        loan.timestamp > 0n,
      ]).to.deep.equal([true, true, true]);

      // After full repayment - inactive loan, zero debt
      await helpers.repay(protocol, usd, borrower, ethers.parseEther("30000"));
      loan = await protocol.loans(borrower.address);
      expect([
        loan.active,
        loan.borrowedAmount,
        loan.collateralAmount > 0n,
      ]).to.deep.equal([false, 0n, true]);
    });
  });


  describe("View Functions & Owner Operations", function () {
    it("Should return accurate data and handle owner functions", async function () {
      const { protocol, owner, borrower } = await loadFixture(deployFixture);

      await helpers.setupLoan(
        protocol,
        borrower,
        ethers.parseEther("2"),
        ethers.parseEther("60000")
      );

      const [
        [
          userCollateral,
          userBorrowed,
          userLtv,
          userLiquidatable,
          userMaxBorrow,
        ],
        [protocolCollateral, protocolBorrowed, btcPrice, utilizationRate],
      ] = await Promise.all([
        protocol.getUserLoan(borrower.address),
        protocol.getProtocolStats(),
      ]);

      expect([
        userCollateral,
        userBorrowed,
        userLtv,
        userLiquidatable,
      ]).to.deep.equal([
        ethers.parseEther("2"),
        ethers.parseEther("60000"),
        60n,
        false,
      ]);
      expect([
        protocolCollateral,
        protocolBorrowed,
        btcPrice,
        utilizationRate,
      ]).to.deep.equal([
        ethers.parseEther("2"),
        ethers.parseEther("60000"),
        MOCK_BTC_PRICE,
        60n,
      ]);

      // Owner operations
      const MockV3Aggregator = await ethers.getContractFactory(
        "MockV3Aggregator"
      );
      const newFeed = await MockV3Aggregator.deploy(8, 60000n * 10n ** 8n);
      await protocol.connect(owner).updatePriceFeed(await newFeed.getAddress());

      const [newPrice] = await protocol.getLatestPrice();
      expect(newPrice).to.equal(60000n * 10n ** 8n);

      // Access control
      await expect(
        protocol.connect(borrower).updatePriceFeed(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(protocol, "OwnableUnauthorizedAccount");
    });
  });

  describe("Edge Cases & Multi-User", function () {
    it("Should handle edge cases and multiple users", async function () {
      const { protocol, usd, borrower, user2 } = await loadFixture(
        deployFixture
      );

      // Edge cases
      const [zeroUsd, zeroMax, zeroLtv] = await Promise.all([
        protocol.btcToUSD(0),
        protocol.getMaxBorrowAmount(0),
        protocol.getLoanToValue(borrower.address),
      ]);
      expect([zeroUsd, zeroMax, zeroLtv]).to.deep.equal([0n, 0n, 0n]);

      // Large amounts
      const largeAmount = ethers.parseEther("1000");
      const [largeUsd, largeMax] = await Promise.all([
        protocol.btcToUSD(largeAmount),
        protocol.getMaxBorrowAmount(largeAmount),
      ]);
      expect([largeUsd, largeMax]).to.deep.equal([
        ethers.parseEther("50000000"),
        ethers.parseEther("35000000"),
      ]);

      // Multi-user operations
      await Promise.all([
        helpers.setupLoan(
          protocol,
          borrower,
          ONE_BTC,
          ethers.parseEther("30000")
        ),
        helpers.setupLoan(
          protocol,
          user2,
          ethers.parseEther("1.5"),
          ethers.parseEther("40000")
        ),
      ]);

      const [loan1, loan2, totalBorrowed] = await Promise.all([
        protocol.loans(borrower.address),
        protocol.loans(user2.address),
        protocol.totalBorrowed(),
      ]);
      expect([
        loan1.borrowedAmount,
        loan2.borrowedAmount,
        totalBorrowed,
      ]).to.deep.equal([
        ethers.parseEther("30000"),
        ethers.parseEther("40000"),
        ethers.parseEther("70000"),
      ]);

      // Concurrent deposits
      const deposits = Array(3)
        .fill()
        .map(() =>
          helpers.deposit(protocol, borrower, ethers.parseEther("0.1"))
        );
      await Promise.all(deposits);

      const finalLoan = await protocol.loans(borrower.address);
      expect(finalLoan.collateralAmount).to.equal(
        ONE_BTC + ethers.parseEther("0.3")
      );
    });

    it("Should handle direct ETH transfers and state transitions", async function () {
      const { protocol, usd, borrower } = await loadFixture(deployFixture);

      // Direct ETH transfer (receive function)
      await expect(
        borrower.sendTransaction({
          to: await protocol.getAddress(),
          value: ONE_BTC,
        })
      ).to.not.be.reverted;

      // State transitions
      let loan = await protocol.loans(borrower.address);
      expect(loan.active).to.be.false;

      await helpers.deposit(protocol, borrower, ONE_BTC);
      loan = await protocol.loans(borrower.address);
      expect(loan.active).to.be.false; // Still false until borrow

      const beforeBorrow = await time.latest();
      await helpers.borrow(protocol, borrower, ethers.parseEther("30000"));
      const afterBorrow = await time.latest();

      loan = await protocol.loans(borrower.address);
      expect(loan.active).to.be.true;
      expect(loan.timestamp).to.be.gte(beforeBorrow).and.lte(afterBorrow);

      await helpers.repay(protocol, usd, borrower, ethers.parseEther("30000"));
      loan = await protocol.loans(borrower.address);
      expect([loan.active, loan.borrowedAmount]).to.deep.equal([false, 0n]);
    });
  });
});
