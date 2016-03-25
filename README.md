# Ether ATM
This is a modified version of the one-way Trofa model of the Lamassu ATM to support two currencies - BTC and ETH.
To install it, you need to:
* Patch the UI, brain and trader files in the machine to support ETH (diff patch files).
* Install lamassu-geth and lamassu-kraken server plugins for the ticker, trader and wallet.
* Update the server config to include the plugin configs (format included):
  - lamassu-geth: `{"account":"","privateKey":"","gas":0,"rpc":""}`
  - lamassu-kraken: `{"key": "", "secret": ""}`
* Update the server config to point:
  - walletEth -> geth
  - traderEth -> kraken
  - tickerEth -> kraken
