const hre = require("hardhat");

async function main() {
  console.log("Deploying lending protocol to Rootstock...");
  
  // Deploy Mock USD token first
  console.log("Deploying Mock USD token...");
  const MockUSD = await hre.ethers.getContractFactory("MockUSD");
  const mockUSD = await MockUSD.deploy();
  await mockUSD.deployed();
  console.log("Mock USD deployed to:", mockUSD.address);
  
  // Deploy Lending Protocol
  console.log("Deploying BTC Lending Protocol...");
  const BTCLendingProtocol = await hre.ethers.getContractFactory("BTCLendingProtocol");
  const lendingProtocol = await BTCLendingProtocol.deploy(mockUSD.address);
  await lendingProtocol.deployed();
  console.log("BTC Lending Protocol deployed to:", lendingProtocol.address);
  
  // Transfer some USD tokens to the lending protocol
  console.log("Funding lending protocol with USD tokens...");
  const fundAmount = hre.ethers.utils.parseEther("100000"); // 100k USD
  await mockUSD.transfer(lendingProtocol.address, fundAmount);
  
  // Verify price feed is working
  try {
    const [price, decimals] = await lendingProtocol.getLatestPrice();
    console.log("BTC/USD Price:", price.toString());
    console.log("Price Feed Decimals:", decimals.toString());
    
    const protocolStats = await lendingProtocol.getProtocolStats();
    console.log("Protocol Stats:", {
      totalCollateral: protocolStats._totalCollateral.toString(),
      totalBorrowed: protocolStats._totalBorrowed.toString(),
      btcPrice: protocolStats.btcPrice.toString(),
      utilizationRate: protocolStats.utilizationRate.toString()
    });
  } catch (error) {
    console.log("Error fetching price data:", error.message);
  }
  
  console.log("\nDeployment Summary:");
  console.log("Mock USD Token:", mockUSD.address);
  console.log("BTC Lending Protocol:", lendingProtocol.address);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });