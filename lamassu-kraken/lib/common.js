'use strict';

var querystring = require('querystring');
var Wreck       = require('wreck');
var crypto      = require('crypto');
var _           = require('lodash');


// copy relevant convienient constants
var config          = require('../config');
var NAME            = config.NAME;
var FINNEY_FACTOR  = config.FINNEY_FACTOR; 

// required by either Wallet or Trader
exports.balance = function balance(callback) {
    return callback(new Error('Not implemented'));
};
