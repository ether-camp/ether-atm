'use strict';

var fs = require('fs');
var cp = require('child_process');
var os = require('os');
var path = require('path');
var _ = require('lodash');
var bunyan = require('bunyan');
var uuid = require('uuid');
var async = require('async');

var SATOSHI_FACTOR = Math.pow(10,8);
var FINNEY_FACTOR = 1e3;
var STATIC_STATES = ['idle', 'networkDown', 'balanceLow', 'unpaired'];
var TRANSACTION_STATES = ['acceptingFirstBill', 'billInserted', 'billRead','acceptingBills',
  'bitcoinsSent', 'completed', 'goodbye'];
var POWER_DOWN_STATES = TRANSACTION_STATES.concat('powerDown');
var BILL_ACCEPTING_STATES = ['billInserted', 'billRead', 'acceptingBills', 'acceptingFirstBill'];
var INITIAL_STATE = 'start';

var Brain = function(config) {
  if (!(this instanceof Brain)) return new Brain(config);
  this.config = config.brain;

  this.dataPath = path.resolve(__dirname, '..', this.config.dataPath);

  var certs = {
    certFile: path.resolve(this.dataPath, this.config.certs.certFile),
    keyFile: path.resolve(this.dataPath, this.config.certs.keyFile),
  };

  this.currency = 'USD';
  this.bootTime = Date.now();

  var wifiConfig = config.wifi;
  wifiConfig.wpaConfigPath = wifiConfig.wpaConfigPath &&
    path.resolve(this.dataPath, wifiConfig.wpaConfigPath);
  if (config.mockWifi) {
    this.wifi = require('./mocks/wifi')(wifiConfig);
  }
  else {
    this.wifi = require('./wifi')(wifiConfig);
  }

  if (config.mockBTC) {
    this.qrScanner = require('./mocks/qr')(config.qr, config.mockBTC);
  }
  else {
    this.qrScanner = require('./qrscanner').factory(config.qr);
  }

  if (config.mockPair) {
    this.pairingQrScanner = require('./mocks/qr')(config.qr, config.mockPair, 'pairing');
  } else {
    this.pairingQrScanner = require('./qrscanner').factory(config.qr, 'pairing');
  }

  if (config.id003Device) config.id003.rs232.device = config.id003Device;

  var connectionInfoPath = path.resolve(this.dataPath, this.config.connectionInfoPath);

  var pairingConfig = {
    certs: certs,
    connectionInfoPath: connectionInfoPath
  };
  this.pairing = require('./pairing')(pairingConfig);

  config.id003.currency = this.currency;
  this.billValidator = require('./id003/id003').factory(config.id003);
  var traderConfig = config.trader;
  traderConfig.currency = this.currency;
  traderConfig.lowestBill = this.billValidator.lowestBill();
  traderConfig.certs = certs;

  if (config.mockTrader)
    this.trader = require('./mocks/trader')(traderConfig);
  else
    this.trader = require('./trader')(traderConfig);


  this.browser = require('./browser')();
  this._setState(INITIAL_STATE);
  this.bitcoinAddress = null;
  this.credit = {fiat: 0, satoshis: 0, lastBill: null};
  this.pending = null;
  this.billsPending = false;
  this.currentScreenTimeout = null;
  this.locked = true;
  this.wifis = null;
  this.screenTimeout = null;
  this.lastTransation = null;
  this.sendOnValid = false;
  this.cancelT0 = Date.now();
  this.lastPowerUp = Date.now();
  this.sessionId = null;
  this.networkDown = true;
  this.balanceLow = false;
  this.hasConnected = false;
  this.localeInfo = this.config.locale.localeInfo;
  this.billValidatorErrorFlag = false;
  this.txLog = bunyan.createLogger({
    name: 'TX',
    streams: [{
      type: 'rotating-file',
      path: path.resolve(this.dataPath, this.config.transactionLogPath),
      period: '1d',
      count: 360
    }]
  });
};

var EventEmitter = require('events').EventEmitter;
var util = require('util');
util.inherits(Brain, EventEmitter);

Brain.prototype.run = function run() {
  console.log('Bitcoin Machine software initialized.');
  this._init();
  this._setUpN7();
  this.browser.listen();
  this._transitionState('booting');
  this.checkWifiStatus();
  this._periodicLog();
};


Brain.prototype._periodicLog = function _periodicLog() {
  var self = this;
  var batteryCapacityPath = this.config.batteryCapacityPath;
  var tempSensorPath = this.config.tempSensorPath;

  var tasks = {};
  if (batteryCapacityPath) tasks.battery = async.apply(fs.readFile, batteryCapacityPath, {encoding: 'utf8'});
  if (tempSensorPath) tasks.temperature = async.apply(fs.readFile, tempSensorPath, {encoding: 'utf8'});

  function reporting() {
    var clauses = ['memUse: %s, memFree: %s, nodeUptime: %s, osUptime: %s'];
    async.parallel(tasks, function (err, results) {
      if (err) return console.log(err);
      if (results.battery) clauses.push('battery: ' + results.battery.trim() + '%');
      if (results.temperature) clauses.push('CPU temperature: ' +
        (results.temperature.trim() / 1000) + '° C');
      var memUse = (process.memoryUsage().rss / Math.pow(1000, 2)).toFixed(1) + ' MB';
      var memFree = (os.freemem() * 100 / os.totalmem()).toFixed(1) + '%';
      var nodeUptimeMs = Date.now() - self.bootTime;
      var nodeUptime = (nodeUptimeMs / 3600000).toFixed(2) + 'h';
      var osUptime = (os.uptime() / 3600).toFixed(2) + 'h';
      var format = clauses.join(', ');
      console.log(format, memUse, memFree, nodeUptime, osUptime);
    });
  }
  reporting();
  setInterval(reporting, this.config.periodicLogInterval);
};

Brain.prototype._connect = function _connect() {
  var self = this;
  if (!this.pairing.hasCert()) this._transitionState('initializing');
  this.pairing.init(function (err) {
    if (err) self.emit('error', err);
    self._startTrading();
  });
};

Brain.prototype._startTrading = function _startTrading() {
  var self = this;
  this.billValidator.run(function (err) {
    if (err) return self._billValidatorErr(err);

    console.log('Bill validator connected.');
    self.trader.init(self.pairing.connectionInfo());

    // We want to wait until heavy CPU heavy certification generation is done
    self.billValidator.monitorHeartbeat();

    self.trader.run();
    self._idle();
  });
};

Brain.prototype.checkWifiStatus = function checkWifiStatus() {
  var self = this;
  this.wifi.status(function(err, status, ip) {
    if (err || status === 'pending') {
      if (err) console.log(err.stack);
      if (self.state !== 'wifiConnecting') self._wifiConnecting();
      self.wifi.waitConnection(function(err, ip) {
        if (err) {
          self.wifi.startScanning();
          self._wifiList();
          return;
        }
        self.config.ip = ip;
        self._wifiConnected();
      });
    } else if (status === 'disconnected') {
      self.wifi.startScanning();
      self._wifiList();
    } else if (status === 'connected') {
      self.config.ip = ip;
      self._wifiConnected();
    }
  });
};

Brain.prototype._initTraderEvents = function _initTraderEvents() {
  var self = this;
  this.trader.on('pollUpdate', function() { self._pollUpdate(); });
  this.trader.on('networkDown', function() { self._networkDown(); });
  this.trader.on('networkUp', function() { self._networkUp(); });
  this.trader.on('error', function(err) { console.log(err.stack); });
  this.trader.on('unpair', function () { self._unpair(); });
};

Brain.prototype._init = function init() {
  var self = this;

  this.wifi.on('scan', function(res) {
    self.wifis = res;
    self.browser.send({wifiList: res});
  });

  this.wifi.on('authenticationError', function(data) {
    console.log('authentication error');
    self.wifi.close();
    self._wifiSelect(data);
  });

  this._initTraderEvents();

  this.browser.on('connected', function() { self._connectedBrowser(); });
  this.browser.on('message', function(req) { self._processRequest(req); });
  this.browser.on('closed', function() { self._closedBrowser(); });
  this.browser.on('messageError', function(err) { console.log('Browser error: ' + err.message); });
  this.browser.on('error', function(err) {
    console.log('Browser connect error: ' + err.message);
    console.log('Likely that two instances are running.');
  });

  this.billValidator.on('error', function(err) { self._billValidatorErr(err); });
  this.billValidator.on('disconnected', function() { self._billValidatorErr(); });
  this.billValidator.on('billAccepted', function() { self._billInserted(); });
  this.billValidator.on('billRead', function(data) { self._billRead(data); });
  this.billValidator.on('billValid', function() { self._billValid(); });
  this.billValidator.on('billRejected', function() { self._billRejected(); });
  this.billValidator.on('timeout', function() { self._billTimeout(); });
  this.billValidator.on('standby', function() { self._billStandby(); });
  this.billValidator.on('jam', function() { self._billJam(); });
  this.billValidator.on('stackerOpen', function() { self._stackerOpen(); });
  this.billValidator.on('enabled', function(data) { self._billsEnabled(data); });

  _.bindAll(this, '_updateConfig');

  this.on('newState', function(state) {
    console.log('new brain state:', state);
  });
};

Brain.prototype._updateConfig = function _updateConfig(config) {
  if(this.state === 'idle') {
    this.rootConfig = config;
    console.log('setting new live config');
  } else {
    console.log('waiting for idle');
    this.once('idle', function() {
      console.log('setting new live config');
      this.rootConfig = config;
    });
  }
  this._writeConfig(config);
};

Brain.prototype._writeConfig = function() {
  // just write user_config?
};

// TODO: abstract this
Brain.prototype._setUpN7 = function _setUpN7() {
  var backlightPath = '/sys/class/backlight/pwm-backlight/brightness';
  if (fs.existsSync(backlightPath)) fs.writeFileSync(backlightPath, '160\n');
  this._setupCheckPower();
};

Brain.prototype._connectedBrowser = function _connectedBrowser() {
//  TODO: have to work on this: console.assert(this.state === 'idle');
  console.log('connected to browser');

  var rec = {
    action: this.state,
    localeInfo: this.localeInfo,
    currency: this.currency,
    exchangeRate: this._exchangeRateRec(this.trader.exchangeRate),
    exchangeRateEth: this._exchangeRateRecEth(this.trader.exchangeRateEth)
  };

  if (this.state === 'wifiList' && this.wifis) rec.wifiList = this.wifis;
  this.browser.send(rec);
};

Brain.prototype._processRequest = function _processRequest(req) {
  this._processReal(req);
};

Brain.prototype._processReal = function _processReal(req) {
  switch(req.button) {
    case 'locked':
      this._locked();
      break;
    case 'unlock':
      this._unlock(req.data);
      break;
    case 'cancelLockPass':
      this._cancelLockPass();
      break;
    case 'wifiSelect':
      this._wifiPass(req.data);
      break;
    case 'wifiConnect':
      this._wifiConnect(req.data);
      break;
    case 'cancelWifiList':
      this._cancelWifiList();
      break;
    case 'cancelWifiPass':
      this._cancelWifiPass();
      break;
    case 'initialize':
      this._connect();
      break;
    case 'pairingScan':
      this._pairingScan();
      break;
    case 'pairingScanCancel':
      this.pairingQrScanner.cancel();
      this._idle();
      break;
    case 'testMode':
      this._testMode();
      break;
    case 'start':
      this.coin = req.data;
      console.log('Using coin: ' + this.coin);
      this._start();
      break;
    case 'cancelScan':
      this._cancelScan();
      break;
    case 'cancelInsertBill':
      this._cancelInsertBill();
      break;
    case 'sendBitcoins':
      this._sendBitcoins();
      break;
    case 'sendEthers':
      this._sendEthers();
      break;
    case 'completed':
      this._completed();
      break;
    case 'machine':
      this._machine();
      break;
    case 'cancelMachine':
      this._cancelMachine();
      break;
    case 'powerOff':
      this._powerOffButton();
      break;
    case 'cam':
      this._cam();
      break;
    case 'fixTransaction':
      this._fixTransaction();
      break;
    case 'abortTransaction':
      this._abortTransaction();
      break;
  }
};

Brain.prototype._setState = function _setState(state, oldState) {
  if (this.state === state) return;

  if (oldState) this._assertState(oldState);

  if (this.currentScreenTimeout) {
    clearTimeout(this.currentScreenTimeout);
    this.currentScreenTimeout = null;
  }
  this.state = state;
  this.emit(state);
  this.emit('newState', state);
};

Brain.prototype._locked = function _locked() {
  this._setState('lockedPass', 'locked');
  this.browser.send({action: 'lockedPass'});
};

Brain.prototype._unlock = function _unlock() {
  this._wifiList();
};

Brain.prototype._cancelLockPass = function _cancelLockPass() {
  this._setState('locked', 'lockedPass');
  this.browser.send({action: 'locked'});
};

Brain.prototype._wifiList = function _wifiList() {
  this._setState('wifiList');
  this.browser.send({action: 'wifiList'});
};

Brain.prototype._wifiPass = function _wifiPass(data) {
  this.browser.send({action: 'wifiPass', wifiSsid: data});
  this.wifi.stopScanning();
  this._setState('wifiPass');
  console.log('connecting to %s', data.ssid);
};

Brain.prototype._wifiConnect = function _wifiConnect(data) {
  this._setState('wifiConnecting', 'wifiPass');
  this.browser.send({action: 'wifiConnecting'});
  var rawSsid = data.rawSsid;
  var ssid = data.ssid;
  var self = this;
  this.wifi.connect(rawSsid, ssid, data.pass, function(err, ip) {
    if (err) {
      // TODO: error screen
      console.log(err.stack);
      var ssidData = {
        ssid: ssid,
        displaySsid: self.wifi.displaySsid(ssid)
      };
      self._wifiPass(ssidData);
    } else {
      self.config.ip = ip;
      self._wifiConnected();
    }
  });
};

Brain.prototype._cancelWifiList = function _cancelWifiList() {
//  this._setState('locked', 'wifiList');
//  this.browser.send({action: 'locked'});
};

Brain.prototype._cancelWifiPass = function _cancelWifiPass() {
  this.browser.send({action: 'wifiList'});
  this.wifi.startScanning();
  this._setState('wifiList', 'wifiPass');
};

Brain.prototype._wifiConnecting = function _wifiConnecting() {
  this._setState('wifiConnecting');
  this.browser.send({action: 'wifiConnecting'});
};

Brain.prototype._wifiConnected = function _wifiConnected() {
  if (this.state === 'maintenance') return;
  this._setState('wifiConnected');

  if (!this.pairing.hasCert()) return this._transitionState('virgin');
  this._connect();
};

Brain.prototype._unpaired = function _unpaired() {
  this._setState('unpaired');
  this.browser.send({action: 'unpaired'});
};

Brain.prototype._pairingScan = function _pairingScan() {
  var self = this;
  this._setState('pairingScan');
  this.browser.send({action: 'pairingScan'});

  this.pairingQrScanner.scan(function(err, json) {
    if (err) return self._pairingError(err);
    self._pair(json);
  });

};

Brain.prototype._pair = function _pair(json) {
  var self = this;
  this._transitionState('pairing');
  this.pairing.pair(json, function (err, connectionInfo) {
    if (err) return self._pairingError(err);
    self.trader.pair(connectionInfo);
    self._idle();
  });
};

Brain.prototype._pairingError = function _pairingError(err) {
  this._setState('pairingError');
  this.browser.send({action: 'pairingError', err: err.message});
};

Brain.prototype._testMode = function _testMode() {
  var self = this;
  this.traderOld = this.trader;
  this.trader.removeAllListeners();
  this.trader = require('./mocks/trader')();
  this._initTraderEvents();
  this.trader.on('finishedTest', function () { self._testModeOff(); });
  this.pairing._connectionInfo = {};
  this.networkDown = false;
  this.balanceLow = false;
  this.trader.run();
  this._idle();
};

Brain.prototype._testModeOff = function _testModeOff() {
  this.pairing._connectionInfo = null;
  this.trader.removeAllListeners();
  this.trader = this.traderOld;
  this._initTraderEvents();
  this._transitionState('virgin');
};

Brain.prototype._idle = function _idle() {
  if (!this.pairing.isPaired() && !this.trader.isMock) return this._unpaired();
  this.sessionId = uuid.v4();
  this.billValidator.lightOff();
  this.qrScanner.clear();

  this._setState('pendingIdle');
  if (this.networkDown) return this._networkDown();
  if (this.balanceLow) return this._balanceLow();
  this._transitionState('idle', this.localeInfo);
};

Brain.prototype._start = function _start() {
  this.browser.send({action: 'scanStart'});
  this._setState('scanAddress', 'idle');
  this._startScan();
};

Brain.prototype._startScan = function _startScan() {
  var self = this;
  var sessionId = this.sessionId;
  this.qrScanner.scan(function(err, address) {
    if (err) self.emit('error', err);
    if (self.sessionId !== sessionId || self.state !== 'scanAddress') return;
    self._handleScan(address);
  }, this.coin == 'ETH');
  this.screenTimeout = setTimeout(function() {
    if (self.state !== 'scanAddress') return;
    self.qrScanner.cancel();
    self._idle();
  }, this.config.qrTimeout);
  this.cancelT0 = Date.now();
};

Brain.prototype._cancelScan = function _cancelScan() {
  if (Date.now() - this.cancelT0 < 500) return;
  this._idle();
  clearTimeout(this.screenTimeout);
  this.qrScanner.cancel();
};

Brain.prototype._cancelInsertBill = function _cancelInsertBill() {
  this._idle();
  this.billValidator.disable();
};

Brain.prototype._exchangeRateRec = function _exchangeRateRec(rate) {
  if (!rate) return null;
  var fiatToXbt = this._truncateBitcoins(1 / rate);
  return {
    xbtToFiat: rate,
    fiatToXbt: fiatToXbt
  };
};

Brain.prototype._exchangeRateRecEth = function _exchangeRateRecEth(rate) {
  if (!rate) return null;
  var fiatToEth = this._truncateBitcoins(1 / rate);
  return {
    ethToFiat: rate,
    fiatToEth: fiatToEth
  };
};

Brain.prototype._pollUpdate = function _pollUpdate() {
  var locale = this.trader.locale;
  this.currency = locale.currency;
  this.localeInfo = locale.localeInfo;
  var rec = {
    currency: this.currency,
    exchangeRate: this._exchangeRateRec(this.trader.exchangeRate),
    exchangeRateEth: this._exchangeRateRecEth(this.trader.exchangeRateEth)
  };
  if (_.contains(STATIC_STATES, this.state)) {
    rec.localeInfo = this.localeInfo;
  }
  this.browser.send(rec);

  if (_.contains(TRANSACTION_STATES, this.state)) return;

  // Don't show Out of Bitcoins on validator restart
  if (!this.billValidator.hasDenominations()) return;

  var fiatBalance;
  if (this.coin == 'BTC') {
      fiatBalance = this.trader.balance;
  } else {
      fiatBalance = this.trader.balanceEth;
  }

  var highestBill = this.billValidator.highestBill(fiatBalance);
  if (highestBill) this._balanceAdequate();
  else this._balanceLow();
};

Brain.prototype._networkDown = function _networkDown() {
  this.networkDown = true;
  if (_.contains(BILL_ACCEPTING_STATES, this.state)) {
    this.billValidator.disable();
    this.browser.send({sendOnly: true});
    return;
  }
  if (_.contains(TRANSACTION_STATES, this.state)) return;
  this._forceNetworkDown();
};

Brain.prototype._forceNetworkDown = function _forceNetworkDown() {
  var self = this;
  if (!this.hasConnected && this.state != 'connecting') {
    this._transitionState('connecting');
    setTimeout(function () {
      self.hasConnected = true;
      if (self.state === 'connecting') self._idle();
    }, self.config.connectingTimeout);
    return;
  }

  if (this.hasConnected) this._transitionState('networkDown');
};

Brain.prototype._networkUp = function _networkUp() {
  // Don't go to start screen yet
  if (!this.billValidator.hasDenominations()) return;

  this.networkDown = false;
  if (this.state === 'networkDown' || this.state === 'connecting' || this.state === 'wifiConnected')
    this._restart();
};

Brain.prototype._balanceLow = function _balanceLow() {
    return;
  this.balanceLow = true;
  if (this.state === 'balanceLow') return;
  if (_.contains(BILL_ACCEPTING_STATES, this.state)) {
    this.billValidator.disable();
    this.browser.send({sendOnly: 'lowBalance'});
    return;
  }
  if (_.contains(TRANSACTION_STATES, this.state)) return;
  this._transitionState('balanceLow');
};

Brain.prototype._transitionState = function _transitionState(state, localeInfo) {
  // TODO refactor code to use this
  // If we're in maintenance state, we stay there till we die
  if (this.state === state || this.state === 'maintenance') return;
  var rec = {action: state};
  if (localeInfo) rec.localeInfo = localeInfo;
  this._setState(state);
  this.browser.send(rec);
};

Brain.prototype._balanceAdequate = function _balanceAdequate() {
  this.balanceLow = false;
  if (this.state === 'balanceLow') this._restart();
};

Brain.prototype._bitcoinFractionalDigits =
    function _bitcoinFractionalDigits(amount) {
  var log = Math.floor(Math.log(amount) / Math.log(10));
  return (log > 0) ? 2 : 2 - log;
};

Brain.prototype._restart = function _restart() {
  console.assert(!this.billsPending, 'Shouldn\'t restart, bills are pending!');
  this._resetState();
  this.billValidator.disable();
  this._idle();
};

Brain.prototype._assertState = function _assertState(expected) {
  var actual = this.state;
  console.assert(actual === expected,
      'State should be ' + expected + ', is ' + actual);
};

Brain.prototype._handleScan = function _handleScan(address) {
  this.browser.send({action: 'scanned', buyerAddress: address});
  this._setState('acceptingFirstBill', 'scanAddress');
  this.bitcoinAddress = address;
  this.billValidator.enable();
  this._screenTimeout(this._restart.bind(this), this.config.billTimeout);
  this._logTx({sessionId: this.sessionId, bitcoinAddress: address},
      'scanAddress');
};

// Bill validating states

Brain.prototype._billInserted = function _billInserted() {
  this.browser.send({action: 'acceptingBill'});
  this._setState('billInserted');
};

Brain.prototype._billRead = function _billRead(data) {
  this._createPendingTransaction(data.denomination);

  var highestBill = null;
  var totalFiat = this.credit.fiat + this.pending.fiat;

  // Trader balance is balance as of start of user session.
  // Reduce it by fiat we owe user.
  var fiatBalance;
  if (this.coin == 'BTC') {
      fiatBalance = this.trader.balance - totalFiat;
  } else {
      fiatBalance = this.trader.balanceEth - totalFiat;
  }


  var txLimit;
  if (this.coin == 'BTC') {
      txLimit = this.trader.txLimit;
  } else {
      txLimit = this.trader.txLimitEth;
  }

  if (txLimit && totalFiat > txLimit) {
    this.billValidator.reject();
    this.pending = null;
    returnState = this.credit.fiat === 0 ?
        'acceptingFirstBill' : 'acceptingBills';
    this._setState(returnState, 'billInserted');

    // If we're here, there's a highestBill. Otherwise, we'd be rejecting all bills and we'd be in sendOnly mode.
    highestBill = this.billValidator.highestBill(txLimit - this.credit.fiat);

    this.browser.send({action: 'highBill', highestBill: highestBill, reason: 'transactionLimit'});
    return;
  }

  console.log('FIAT balance: ' + fiatBalance);
  if (fiatBalance >= 0) {
    this.billValidator.stack();
    highestBill = this.billValidator.highestBill(fiatBalance);
    var sendOnly = (highestBill === null);
    if (sendOnly) {
      this.billValidator.disable();
      this._balanceLow();
    }
    var sendToBrowser = {
      action: 'acceptingBill',
      credit: this._uiCredit(),
      sendOnly: sendOnly
    };
    console.log('SENDING to BROWSER: ' + JSON.stringify(sendToBrowser));
    this.browser.send(sendToBrowser);
    this._setState('billRead');
  } else {
    this.billValidator.reject();
    this.pending = null;
    var returnState = this.credit.fiat === 0 ?
        'acceptingFirstBill' : 'acceptingBills';
    this._setState(returnState, 'billInserted');
    var newFiatBalance = this.trader.balance - this.credit.fiat;
    var newHighestBill = this.billValidator.highestBill(newFiatBalance);

    if (newHighestBill)
      this.browser.send({action: 'highBill', highestBill: newHighestBill, reason: 'lowBalance'});
    else if (this.credit.fiat === 0) {
      this.billValidator.disable();
      this._balanceLow();
    } else {
      this.billValidator.disable();
      this.browser.send({credit: this._uiCredit(), sendOnly: true});
      this._balanceLow();
    }
  }
};

Brain.prototype._billValid = function _billValid() {
  this._setState('acceptingBills', 'billRead');
  var pending = this.pending;

  // No going back
  this.billsPending = true;

  // Update running total
  this.pending = null;
  this.credit.fiat += pending.fiat;
  this.credit.satoshis += pending.satoshis;
  this.credit.finneys += pending.finneys;
  this.credit.lastBill = pending.fiat;

  // Puts in the trade to cover currency exchange risk
  // and replenish bitcoin reserves
  var tradeRec = _.clone(pending);
  tradeRec.currency = this.currency;  // TODO: This should be a per tx attribute
  tradeRec.sessionId = this.sessionId;
  var txLimit;
  if (this.coin == 'BTC') {
      this.trader.trade(tradeRec);
      txLimit = this.trader.txLimit;
  } else {
      this.trader.tradeEth(tradeRec);
      txLimit = this.trader.txLimitEth;
  }

  if (txLimit !== null &&
      this.credit.fiat + this.billValidator.lowestBill() > txLimit) {
    this.billValidator.disable();
    this.browser.send({credit: this._uiCredit(), sendOnly: 'transactionLimit'});
  }

  var self = this;
  this._screenTimeout(function() { 
    if (self.coin == 'BTC') {
      self._sendBitcoins(); 
    } else {
        self._sendEthers();
    }
  
  },
      this.config.billTimeout);

  if (this.sendOnValid) {
    this.sendOnValid = false;
    if (this.coin == 'BTC') {
        this._doSendBitcoins();
    } else {
        this._doSendEthers();
    }
  }
  var rec;

  if (this.coin == 'BTC') {
      rec = {
        sessionId: this.sessionId,
        bill: pending.fiat,
        currency: this.currency,
        bitcoins: this._satoshisToBitcoins(pending.satoshis),
        satoshis: this._truncateSatoshis(pending.satoshis),
      };
  } else {
      rec = {
        sessionId: this.sessionId,
        bill: pending.fiat,
        currency: this.currency,
        ethers: this._finneysToEthers(pending.finneys),
        finneys: this._truncateFinneys(pending.finneys),
      };
  }
  this._logTx(rec, 'validateBill');
};

// TODO: clean this up
Brain.prototype._billRejected = function _billRejected() {
  this.browser.send({action: 'rejectedBill'});
  this.pending = null;
  var returnState = this.credit.fiat === 0 ?
      'acceptingFirstBill' : 'acceptingBills';
  if (this.state !== 'balanceLow') this._setState(returnState);
  var credit = this._uiCredit();
  if (!credit.fiat || credit.fiat === 0) credit = null;
  var response = {
    action: 'rejectedBill',
    credit: credit
  };

  if (this.sendOnValid) {
    this.sendOnValid = false;
    if (credit !== null) {
      this._setState('acceptingBills');
      if (this.coin == 'BTC') {
          this._doSendBitcoins();
      } else {
          this._doSendEthers();
      }
      this.browser.send({credit: credit});
      return;
    }
    response.action = 'acceptingFirstBill';
  }

  this.browser.send(response);
};

Brain.prototype._billStandby = function _billStandby() {
  if (this.state === 'acceptingBills' || this.state === 'acceptingFirstBill')
    this.billValidator.enable();
};

Brain.prototype._billJam = function _billJam() {
  // TODO FIX: special screen and state for this
  this.browser.send({action: 'networkDown'});
};

Brain.prototype._billsEnabled = function _billsEnabled(data) {
  console.log('Bills enabled codes: 0x%s, 0x%s', data.data1.toString(16), data.data2.toString(16));
};

Brain.prototype._stackerOpen = function _stackerOpen() {
  this._logTx({currency: this.currency}, 'cashboxRemoved');
};

Brain.prototype._uiCredit = function _uiCredit() {
  var credit = this.credit;
  var fiat = credit.fiat;
  var satoshis = credit.satoshis;
  var finneys = credit.finneys;
  var lastBill = null;

  if (this.pending) {
    var pending = this.pending;
    fiat += pending.fiat;
    satoshis += pending.satoshis;
    finneys += pending.finneys;
    lastBill = pending.fiat;
  } else {
    lastBill = credit.lastBill;
  }

  if (this.coin == 'BTC') {
      var bitcoins = this._satoshisToBitcoins(satoshis);
      return {
        fiat: fiat,
        bitcoins: bitcoins,
        lastBill: lastBill
      };
  } else {
      var ethers = this._finneysToEthers(finneys);
      return {
        fiat: fiat,
        ethers: ethers,
        lastBill: lastBill
      };
  }
};

Brain.prototype._satoshisToBitcoins = function _satoshisToBitcoins(satoshis) {
  return this._truncateBitcoins(satoshis / SATOSHI_FACTOR);
};

Brain.prototype._finneysToEthers = function _finneysToEthers(finneys) {
  return this._truncateBitcoins(finneys / FINNEY_FACTOR);
};

Brain.prototype._createPendingTransaction =
    function _createPendingTransaction(bill) {
  console.assert(this.pending === null);
  var exchangeRate = this.trader.exchangeRate;
  var ethExchangeRate = this.trader.exchangeRateEth;
  console.assert(exchangeRate, 'Exchange rate not set');
  if (this.coin == 'BTC') {
      var satoshiRate = SATOSHI_FACTOR / exchangeRate;
      var satoshis = this._truncateSatoshis(bill * satoshiRate);

      this.pending = {
        fiat: bill,
        exchangeRate: exchangeRate,
        satoshis: satoshis
      };
  } else {
      var finneyRate = FINNEY_FACTOR / ethExchangeRate;
      var finneys = this._truncateFinneys(bill * finneyRate);

      this.pending = {
        fiat: bill,
        exchangeRate: ethExchangeRate,
        finneys: finneys
      };
  }
};

Brain.prototype._sendBitcoins = function _sendBitcoins() {
  this.browser.send({
    action: 'bitcoinTransferPending',
    buyerAddress: this.bitcoinAddress
  });

  if (this.state === 'acceptingBills') this._doSendBitcoins();
  else this.sendOnValid = true;
};

Brain.prototype._sendEthers = function _sendBitcoins() {
  this.browser.send({
    action: 'etherTransferPending',
    buyerAddress: this.bitcoinAddress
  });

  if (this.state === 'acceptingBills') this._doSendEthers();
  else this.sendOnValid = true;
};

Brain.prototype._doSendBitcoins = function _doSendBitcoins() {
  this._setState('bitcoinsSent', 'acceptingBills');
  this.billValidator.disable();

  this.pending = null;

  this.lastTransaction = {
    address: this.bitcoinAddress,
    credit: this._uiCredit()
  };

  var self = this;
  var satoshis = this._truncateSatoshis(this.credit.satoshis);

  var rec = {
    sessionId: this.sessionId,
    bitcoins: this._satoshisToBitcoins(this.credit.satoshis),
    satoshis: satoshis,
    fiat: this.credit.fiat,
    currency: this.currency
  };
  this._logTx(rec, 'bitcoinsRequested');

  var tx = {
    txId: this.sessionId,
    toAddress: this.bitcoinAddress,
    satoshis: satoshis,
    currencyCode: this.currency,
    fiat: this.credit.fiat
  };
  this.trader.sendBitcoins(tx, function(err, transactionHash) {
      if (err) self._sendBitcoinsError(err);
      else self._sendBitcoinsHandler(transactionHash);
    });
};

Brain.prototype._doSendEthers = function _doSendEthers() {
  this._setState('bitcoinsSent', 'acceptingBills');
  this.billValidator.disable();

  this.pending = null;

  this.lastTransaction = {
    address: this.bitcoinAddress,
    credit: this._uiCredit()
  };

  var self = this;
  var finneys = this._truncateFinneys(this.credit.finneys);

  var rec = {
    sessionId: this.sessionId,
    ethers: this._finneysToEthers(this.credit.finneys),
    finneys: finneys,
    fiat: this.credit.fiat,
    currency: this.currency
  };
  this._logTx(rec, 'ethersRequested');

  var tx = {
    txId: this.sessionId,
    toAddress: this.bitcoinAddress,
    finneys: finneys,
    currencyCode: this.currency,
    fiat: this.credit.fiat
  };
  this.trader.sendEthers(tx, function(err, transactionHash) {
      if (err) self._sendEthersError(err);
      else self._sendEthersHandler(transactionHash);
    });
};



// Giving up, go to special screens asking user to contact operator
Brain.prototype._sendBitcoinsError = function _sendBitcoinsError(err) {
  var rec = {
    sessionId: this.sessionId,
    error: err.message
  };
  this._logTx(rec, 'error');
  console.log('Error sending bitcoins: %s', err.message);

  // TODO TEMP need new, friendly screens for this

  // Giving up
  this.billsPending = false;
  this._resetState();

  var self = this;
  if (err.status === 'InsufficientFunds') {
    setTimeout(function () { self._idle(); }, self.config.insufficientFundsTimeout);
    return this._transitionState('insufficientFunds');
  }

  this._transitionState('withdrawFailure');
  this.networkDown = true;
  this._screenTimeout(this._idle.bind(this), 10000);
};

Brain.prototype._sendEthersError = function _sendEthersError(err) {
  var rec = {
    sessionId: this.sessionId,
    error: err.message
  };
  this._logTx(rec, 'error');
  console.log('Error sending ethers: %s', err.message);

  // TODO TEMP need new, friendly screens for this

  // Giving up
  this.billsPending = false;
  this._resetState();

  var self = this;
  if (err.status === 'InsufficientFunds') {
    setTimeout(function () { self._idle(); }, self.config.insufficientFundsTimeout);
    return this._transitionState('insufficientFunds');
  }

  this._transitionState('withdrawFailureEth');
  this.networkDown = true;
  this._screenTimeout(this._idle.bind(this), 10000);
}

Brain.prototype._truncateBitcoins = function _truncateBitcoins(bitcoins) {
  var decimalDigits = this._bitcoinFractionalDigits(bitcoins);
  var adjuster = Math.pow(10, decimalDigits);
  return (Math.floor(bitcoins * adjuster) / adjuster);
};

Brain.prototype._truncateSatoshis = function _truncateSatoshis(satoshis) {
  var bitcoins = satoshis / SATOSHI_FACTOR;
  var truncated = this._truncateBitcoins(bitcoins);
  return Math.floor(truncated * SATOSHI_FACTOR);
};

Brain.prototype._truncateFinneys = function _truncateFinneys(satoshis) {
  var bitcoins = satoshis / FINNEY_FACTOR;
  var truncated = this._truncateBitcoins(bitcoins);
  return Math.floor(truncated * FINNEY_FACTOR);
};

// And... we're done!
Brain.prototype._sendBitcoinsHandler =
    function _sendBitcoinsHandler(transactionHash) {
  this._setState('completed');

  var url = transactionHash ?
    'http://blockchain.info/tx/' + transactionHash :
    'http://blockchain.info/address/' + this.bitcoinAddress;
  this.browser.send({
    action: 'bitcoinTransferComplete',
    transactionHashURL: url
  });

  var rec = {
    sessionId: this.sessionId,
    transactionHash: transactionHash,
    bitcoins: this._satoshisToBitcoins(this.credit.satoshis),
    satoshis: this._truncateSatoshis(this.credit.satoshis),
    fiat: this.credit.fiat,
    currency: this.currency
  };
  this._logTx(rec, 'bitcoinsSent');

  this.billsPending = false;
  this._resetState();
  this._screenTimeout(this._completed.bind(this), this.config.completedTimeout);
};

Brain.prototype._sendEthersHandler =
    function _sendEthersHandler(transactionHash) {
  this._setState('completed');

  var url = transactionHash ?
    'http://blockchain.info/tx/' + transactionHash :
    'http://blockchain.info/address/' + this.bitcoinAddress;
  this.browser.send({
    action: 'etherTransferComplete',
    transactionHashURL: url
  });

  var rec = {
    sessionId: this.sessionId,
    transactionHash: transactionHash,
    ethers: this._finneysToEthers(this.credit.finneys),
    finneys: this._truncateFinneys(this.credit.finneys),
    fiat: this.credit.fiat,
    currency: this.currency
  };
  this._logTx(rec, 'bitcoinsSent');

  this.billsPending = false;
  this._resetState();
  this._screenTimeout(this._completed.bind(this), this.config.completedTimeout);
};



Brain.prototype._screenTimeoutHandler = function _screenTimeoutHandler(callback) {
  this.currentScreenTimeout = null;
  callback();
};

Brain.prototype._screenTimeout = function _screenTimeout(callback, timeout) {
  console.assert(!this.currentScreenTimeout,
      'Can\'t have two screen timeouts at once');
  var self = this;
  this.currentScreenTimeout =
      setTimeout(function() { self._screenTimeoutHandler(callback); }, timeout);
};

Brain.prototype._completed = function _completed() {
  // TODO: Be idempotent
  this.browser.send({action: 'goodbye'});
  this._setState('goodbye', 'completed');

  if (this.billValidatorErrorFlag) {
    this._transitionState('maintenance');
    this.emit('error', new Error('Bill validator error, exiting post transaction.'));
  }

  this._screenTimeout(this._restart.bind(this), this.config.goodbyeTimeout);
};

Brain.prototype._machine = function _machine() {
  this.browser.send({action: 'machine', machineInfo: this.config.unit});
  this._setState('machine');
};

Brain.prototype._cancelMachine = function _cancelMachine() {
  this._idle();
};

Brain.prototype._powerOffButton = function _powerOffButton() {
  var self = this;
  this.wifi.clearConfig(function () {
    self._powerOff();
  });
};

Brain.prototype._powerOff = function _powerOff() {
  this._setState('powerOff');
  console.log('powering off');
  cp.execFile('poweroff', ['-d', '2'], {}, function() {
    process.exit(0);
  });
};

Brain.prototype._cam = function _cam() {
  console.log('calibrating camera');
  this.qrScanner.view();
};

Brain.prototype._fixTransaction = function _fixTransaction() {
  this._setState('fixTransaction');
  this.browser.send({
    action: 'fixTransaction',
    lastTransaction: this.lastTransaction
  });
};

Brain.prototype._abortTransaction = function _abortTransaction() {
  this.billsPending = false;
  this._restart();
};

Brain.prototype._resetState = function _resetState() {
  console.assert(!this.billsPending);
  this.bitcoinAddress = null;
  this.credit.fiat = 0;
  this.credit.satoshis = 0;
  this.credit.finneys = 0;
  this.credit.lastBill = null;
  this.pending = null;
};

Brain.prototype._setupCheckPower = function _setupCheckPower() {
  var self = this;
  setInterval(function() {
    self._checkPower();
  }, this.config.checkPowerTime);
};

// This can only get called when we're not in a transaction
Brain.prototype._checkPower = function _checkPower() {
  if (_.contains(POWER_DOWN_STATES, this.state)) return;

  // TODO: factor this out to a device-specific module
  var powerStatusPath = this.config.powerStatus;
  if (!powerStatusPath) return;

  var self = this;
  fs.readFile(powerStatusPath, {encoding: 'utf8'}, function(err,  res) {
    if (err) return console.log(err.stack);
    if (res.match(/^Discharging/)) {
      console.log('Sensed power down.');
      var elapsed = Date.now() - self.lastPowerUp > self.config.checkPowerTimeout;
      if (!elapsed) return;
      console.log('Device unplugged. Powering down. Forgetting WiFi.');
      self._setState('powerDown');
      self.wifi.clearConfig(function () {
        self._powerOff();
        return;
      });
    }
    self.lastPowerUp = Date.now();
  });
};

Brain.prototype._logTx = function _logTx(rec, msg) {
  this.txLog.info(rec, msg);
};

Brain.prototype._unpair = function _unpair() {
  var self = this;

  console.log('Unpairing');
  self.trader.stop();
  self.pairing.unpair(function () {
    console.log('Unpaired');
    self._setState('unpaired');
    self.browser.send({action: 'unpaired'});
  });
};

Brain.prototype._billValidatorErr = function _billValidatorErr(err) {
  if (!err) err = new Error('Bill Validator error');

  if (this.billValidatorErrorFlag) return;  // Already being handled

  if (this.billsPending) {
    this.billValidatorErrorFlag = true;
    this.billValidator.disable(); // Just in case. If error, will get throttled.
    this.browser.send({credit: this._uiCredit(), sendOnly: true});
    return;
  }
  this._transitionState('maintenance');
  this.emit('error', err);
};

module.exports = Brain;
