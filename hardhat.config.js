require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: "0.8.28",
  networks: {
    rskTestnet: {
      url: "https://public-node.testnet.rsk.co",
      chainId: 31,
      gasPrice: "auto", 
      accounts: [
        // Add your private key here (use environment variables in production)
        process.env.PRIVATE_KEY,
      ]
    },
    rskMainnet: {
      url: "https://public-node.rsk.co",
      chainId: 30,
      gasPrice: "auto",
      accounts: [
        // Add your private key here (use environment variables in production)
        process.env.PRIVATE_KEY,
      ]
    }
  }
};