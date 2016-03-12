'use strict';

var _ = require('lodash');

exports.NAME = 'Kraken';
exports.SUPPORTED_MODULES = ['ticker', 'trader'];


exports.FINNEY_FACTOR = 1e3;
exports.FUDGE_FACTOR = 1.05;

exports.config = function config(localConfig) {
  if (localConfig) _.merge(exports, localConfig);
};
