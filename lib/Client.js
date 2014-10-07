var zmq = require('zmq');
var Readable = require('readable-stream').Readable;
var debug = require('debug')('ZMQ-OMDP:Client');
var uuid = require('shortid');
var util = require('util');
var events = require('events');
var MDP = require('./mdp');

var HEARTBEAT_LIVENESS = 3;

function Client(broker, conf) {
    this.broker = broker;

	this.conf = {
		heartbeat: 2500,
		timeout: 60000,
		name: 'C' + uuid.generate()
	};

	var self = this;

	Object.keys(conf || {}).every(function(k) {
		self.conf[k] = conf[k];
	});

    this.reqs = {};
	
    events.EventEmitter.call(this);
};
util.inherits(Client, events.EventEmitter);

Client.prototype.start = function() {
	var self = this;

	this.socket = zmq.socket('dealer');
	this.socket.identity = new Buffer(this.conf.name);

	this.socket.on('message', function() {
		self.onMsg.call(self, arguments);
	});

	this.socket.on('error', function(err) {
		self.emitErr(err); 
	});
	
	this.socket.connect(this.broker);

	if (this.conf.debug) {
		debug('Client connected to %s', this.broker);
	}

	this.hbTimer = setInterval(function() {
		self.heartbeat();
		setImmediate(function() {
			Object.keys(self.reqs).every(function(rid) {
				var req = self.reqs[rid];
				if (req.timeout > -1 && ((new Date()).getTime() > req.lts + req.timeout)) {
					self.onMsg([MDP.CLIENT, MDP.W_REPLY, new Buffer(rid), new Buffer('C_TIMEOUT')]);
				}
				return true;
			});
		});
	}, this.conf.heartbeat);
};

Client.prototype.stop = function() {
	if (this.socket) {
		clearInterval(this.hbTimer);
		this.socket.close();
		delete this.socket;
	}
};

Client.prototype.send = function(msg) {
	var self = this;

	process.nextTick(function() {
		if (self.socket) {
			self.socket.send(msg);
		}
	});
};

Client.prototype.onMsg = function(msg) {
	var header = msg[0].toString();
	var type = msg[1];

	if (header != MDP.CLIENT) {
		this.emitErr('ERR_MSG_HEADER');
		return;
	}

	if (msg.length < 3) {
		return;
	}

	var rid = msg[2].toString();
	var req = this.reqs[rid];
	if (!req) {
		return;
	}

	var err = msg[3] || null;
	var data = msg[4] || null;

	if (err) {
		err = err.toString();
		if (err == 0) {
			err = null;
		} else {
			err = JSON.parse(err);
		}
	}

	if (data) {
		data = JSON.parse(data.toString());
	}

	if (type == MDP.W_REPLY || type == MDP.W_REPLY_PARTIAL) {
		req.lts = new Date().getTime();

		if (type == MDP.W_REPLY) {
			req._finalMsg = [err, data];
			req.ended = true;
			delete this.reqs[rid];
		}

		if (err) {
			req.stream.emit('error', err);
		}

		req.stream.push(data);

		if (type == MDP.W_REPLY) {
			req.stream.push(null);
		}
	} else {
		this.emitErr('ERR_MSG_TYPE');
	}
};

Client.prototype.emitErr = function(msg) {
	this.emit.apply(this, ['error', msg]);
};

function noop() {};

function _request(serviceName, data, opts) {
	var self = this;
	var rid = uuid.generate();

	if (typeof opts != 'object') {
		opts = {};
	}	

	opts.timeout = opts.timeout || this.conf.timeout;

	var req = this.reqs[rid] = {
		rid: rid,
		timeout: opts.timeout,
		ts: new Date().getTime(),
		opts: opts,
		heartbeat: function() {
			self.heartbeat(rid);
		},
		_finalMsg: null, 
		ended: false
	};

	req.lts = req.ts;

	var stream = new Readable({ objectMode: true });

	stream._read = noop;
	stream.heartbeat = req.heartbeat;

	req.stream = stream;

	if (this.conf.debug) {
		debug('C: send request', serviceName, rid);
	}

	this.send([
		MDP.CLIENT, MDP.W_REQUEST, serviceName, rid, 
		JSON.stringify(data), JSON.stringify(opts)
	]);

	return req;
};

Client.prototype.requestStream = function(serviceName, data, opts) {
	return this.request(serviceName, data, undefined, undefined, opts);
};

Client.prototype.request = function(serviceName, data, partialCb, finalCb, opts) {
	var self = this;

	var req = _request.call(this, serviceName, data, opts);
	
	req.stream.on('data', function(data) {
		if (req.ended) {
			return;
		}

		if (partialCb) {
			partialCb(null, data);
		}
	});

	req.stream.on('end', function() {
		var msg = req._finalMsg;
		if (finalCb) {
			finalCb(msg[0], msg[1]);
		}
	});

	req.stream.on('error', function() {});

	return req.stream;
};

Client.prototype.heartbeat = function(rid) {
	var msg = [MDP.CLIENT, MDP.W_HEARTBEAT];
	if (rid) {
		msg.push(rid);
	}
	this.send(msg);
};

module.exports = Client;
