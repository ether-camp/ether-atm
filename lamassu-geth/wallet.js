'use strict';

var async       = require('async');
var _           = require('lodash');


exports.NAME = 'Geth';
exports.SUPPORTED_MODULES = ['walletEth'];

var web3 = require('web3');
var Tx = require('ethereumjs-tx');


var pluginConfig = {};
var GAS;
var privateKey;
var account;

var fs = require('fs');

exports.config = function config(localConfig) {
  if (localConfig) _.merge(pluginConfig, localConfig);
  // Expected maximum time for a block to complete, in minutes

  if (!web3.isConnected()) {
      web3.setProvider(new web3.providers.HttpProvider(pluginConfig.rpc));
  }
  account = pluginConfig.account;

  GAS = pluginConfig.gas;
  privateKey = pluginConfig.privateKey;
};

exports.sendEthers = function sendEthers(address, finneys, cb) {
//  if (fee !== null)
//    data.fee = fee;
  var gasPrice;  
  try {
      gasPrice = web3.eth.gasPrice;
  } catch (e) {
      try {
          gasPrice = web3.eth.gasPrice;
      } catch (e) {
          return cb(e);
      }
  }
  var nonce;
  try {
      nonce = web3.eth.getTransactionCount(account, 'pending');
  } catch (e) {
      try {
          nonce = web3.eth.getTransactionCount(account, 'pending');
      } catch (e) {
          return cb(e);
      }
  }
  var rawTx = {
      from: account,
      nonce: nonce,
      gasPrice: web3.toHex(gasPrice.toString()),
      gasLimit: web3.toHex(GAS),
      to: address,
      value: web3.toHex(web3.toWei(finneys, 'finney'))
  };
  var tx = new Tx(rawTx);
  tx.sign(new Buffer(privateKey, 'hex'));
  var serializedTx = tx.serialize().toString('hex');
  web3.eth.sendRawTransaction(serializedTx, {from: account}, function (err, txId) {
      console.log(txId);
    if (err) {
      console.log(err);
      return cb(err);
    }

    cb(null, txId);
  });
};

exports.balance = function balance(cb) {
  web3.eth.getBalance(account, 'pending', function (err, balance) {
      if (err) {
          return cb(err);
      }

      cb(null, {
          USD: 0,
          ETH: web3.fromWei(balance.toString(), 'finney')
      });

    });
};

exports.newAddress = function newAddress(info, cb) {
  cb(new Error('Not supported'));
};
