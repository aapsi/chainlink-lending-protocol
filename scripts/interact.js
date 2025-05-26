const hre = require("hardhat");

async function main() {
  const lendingAddress = "YOUR_LENDING_CONTRACT_ADDRESS";
  const usdAddress = "YOUR_USD_TOKEN_ADDRESS";
  
  const BTCLendingProtocol = await hre.ethers.getContractFactory("BTCLendingProtocol");
  const MockUSD = await hre.ethers.getContractFactory("MockUSD");
  
  const lending = BTCLendingProtocol.attach(lendingAddress);
  const usdToken = MockUSD.attach(usdAddress);
  
  const [signer] = await hre.ethers.getSigners();
  console.log("Interacting with account:", signer.address);
  
  // Get current BTC price
  console.log("\n=== Current Market Data ===");
  const [price, decimals] = await lending.getLatestPrice();
  console.log("BTC/USD Price:", price.toString());
  console.log("Price Decimals:", decimals.toString());
  
  // Get protocol statistics
  const stats = await lending.getProtocolStats();
  console.log("Total Collateral (RBTC):", hre.ethers.utils.formatEther(stats._totalCollateral));
  console.log("Total Borrowed (USD):", hre.ethers.utils.formatEther(stats._totalBorrowed));
  console.log("Utilization Rate:", stats.utilizationRate.toString() + "%");
  
  // Deposit collateral
  console.log("\n=== Depositing Collateral ===");
  const collateralAmount = hre.ethers.utils.parseEther("0.01"); // 0.01 RBTC
  
  const depositTx = await lending.depositCollateral({ value: collateralAmount });
  await depositTx.wait();
  console.log("Deposited 0.01 RBTC as collateral");
  
  // Check borrowing capacity
  const maxBorrow = await lending.getMaxBorrowAmount(collateralAmount);
  console.log("Max borrowable amount:", hre.ethers.utils.formatEther(maxBorrow), "USD");
  
  // Borrow against collateral
  console.log("\n=== Taking Loan ===");
  const borrowAmount = maxBorrow.div(2); // Borrow 50% of max
  
  const borrowTx = await lending.borrow(borrowAmount);
  await borrowTx.wait();
  console.log("Borrowed:", hre.ethers.utils.formatEther(borrowAmount), "USD");
  
  // Check loan status
  console.log("\n=== Loan Status ===");
  const loanInfo = await lending.getUserLoan(signer.address);
  console.log("Collateral:", hre.ethers.utils.formatEther(loanInfo.collateral), "RBTC");
  console.log("Borrowed:", hre.ethers.utils.formatEther(loanInfo.borrowed), "USD");
  console.log("Loan-to-Value Ratio:", loanInfo.ltv.toString() + "%");
  console.log("Is Liquidatable:", loanInfo.liquidatable);
  
  // Check USD token balance
  const usdBalance = await usdToken.balanceOf(signer.address);
  console.log("USD Token Balance:", hre.ethers.utils.formatEther(usdBalance));
  
  console.log("\n=== Simulation Complete ===");
  console.log("Contract successfully demonstrates:");
  console.log("✓ Real-time BTC price fetching from Chainlink");
  console.log("✓ Collateral-based lending calculations");
  console.log("✓ Loan-to-value ratio monitoring");
  console.log("✓ Liquidation risk assessment");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });