'use strict';

var KrakenClient = require('kraken-api');
var kraken = new KrakenClient('api_key', 'api_secret');

// copy relevant convienient constants
var config        = require('../config');

exports.ticker = function ticker(currencies, callback) {
  if (typeof currencies === 'string')
    currencies = [currencies];

  currencies.sort();

  if(currencies.length === 0)
    return callback(new Error('Currency not specified'));

  kraken.api('Ticker', {"pair": "XXBTZUSD,ETHXBT"}, function (error, dataRaw) {
      if (error) {
          return callback(error);
      }
      var data = dataRaw.result;
      var usdRate = {
        ask: parseFloat(data['XXBTZUSD'].a),
        bid: parseFloat(data['XXBTZUSD'].b)
      };

      var btcRate = {
        ask: parseFloat(data['XETHXXBT'].a),
        bid: parseFloat(data['XETHXXBT'].b)
      };

      var response = {};
      if (currencies.indexOf('USD') !== -1)
        response.USD = {
          currency: 'USD',
          rates: {
              ask: parseFloat(usdRate.ask * btcRate.bid).toFixed(2),
              bid: parseFloat(usdRate.bid * btcRate.ask).toFixed(2)
          }
        };


      if (currencies.length !== Object.keys(response).length)
        return callback(new Error('Unsupported currency'));

      callback(null, response);

  });
};
