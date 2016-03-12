'use strict';

var DEBUG = false;
var common      = require('./common');
var ticker      = require('./ticker').ticker;

var KrakenClient = require('kraken-api');

// copy relevant convienient constants
var config          = require('../config');
var FINNEY_FACTOR  = config.FINNEY_FACTOR;
var FUDGE_FACTOR    = config.FUDGE_FACTOR;

var kraken;

exports.purchase = function purchase(finneys, opts, callback) {

    if (!kraken) {
        kraken = new KrakenClient(config.key, config.secret);
    }
    console.log('trading');
    var ethers = finneys / FINNEY_FACTOR;
    var amountStr = ethers.toFixed(8);

    // Buy at market price, when validate is true only check but do not fulfill
    var orderInfo = { 'pair' : 'XETHXXBT',
              'type' : 'buy',
              'ordertype' : 'market',
              'volume': amountStr
            };
    kraken.api('AddOrder', orderInfo, function(error, response) {
    if (error) {
        console.log(error);
        return callback(error);
    }
    else {
        console.log(response.result);
        if (DEBUG) {
        console.log(response.result);
        }
        return callback();
    }
    });
};

exports.sell = function sell(finneys, opts, callback) {
    console.log('trading');
     if (!kraken) {
        kraken = new KrakenClient(config.key, config.secret);
    }
    var ethers = finneys / FINNEY_FACTOR;
    var amountStr = ethers.toFixed(8);

    // Buy at market price, when validate is true only check but do not fulfill
    var orderInfo = { 'pair' : 'XETHXXBT',
              'type' : 'buy',
              'ordertype' : 'market',
              'volume': amountStr
            };
    kraken.api('AddOrder', orderInfo, function(error, response) {
    if (error) {
        console.log(error);
        return callback(error);
    }
    else {
        if (DEBUG) {
        console.log(response.result);
        }
        return callback();
    }
    });
};
