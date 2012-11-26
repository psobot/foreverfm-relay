//  Forever.fm relay server
//  Simple, lightweight, untested.

var config = {
    listener_limit: 1,   //  Each listener uses between 25 and 35 kilobytes per second.
    max_monthly_transfer: 1099511627776,  // 1TB
    relay_provider: "Peter Sobot",
    relay_attribution_link: "http://psobot.com",
    relay_location: "New York, NY",
    port: process.env.PORT || 8192,
    timeout: 1000 // ms
};

var http = require('http');
var winston = require('winston');
var daemon = require("daemonize2").setup({
    main: "relay.js",
    name: "relay",
    pidfile: "relay.pid"
});

var options = {
    hostname: "forever.fm",
    path: "/all.mp3",
    port: 80,
    headers: {
      "Connection": "keep-alive",
      'User-Agent': 'foreverfm-relay',
      'X-Relay-Port': config.port
    }
};
var listeners = [];
var bytes_in_month = 0;
var bytes_out_month = 0;
var started = +new Date;
var month = (new Date()).getMonth();
var peaks = {
    listeners: 0,
    bytes_out_month: 0
};

var __transfer_exceeded = false;
var transfer_exceeded = function() {
    cur_month = (new Date()).getMonth();
    if (month != cur_month) {
        month = cur_month;
        bytes_out_month = 0;
        bytes_in_month = 0;
    }
    __transfer_exceeded = bytes_out_month > config.max_monthly_transfer;
    return __transfer_exceeded;
}

winston.level = 'log';
winston.add(winston.transports.File, { filename: 'relay.log', handleExceptions: true });

var check = function(callback) {
    winston.info("Attempting to connect to generator...");
    check_opts = {'method': 'HEAD'};
    for (var a in options) check_opts[a] = options[a];
    req = http.request(check_opts, function (res) {
        if ( res.statusCode != 200 && res.statusCode != 405 ) {
            winston.error("OH NOES: Got a " + res.statusCode);
        } else {
            winston.info("Got response back from generator!")
            if (typeof callback != "undefined") callback();
        }
    })
    req.end();
}

var listen = function(callback) {
    winston.info("Attempting to listen to generator...");
    req = http.request(options, function (res) {
        if ( res.statusCode != 200 ) {
            winston.error("OH NOES: Got a " + res.statusCode);
            setTimeout(function(){listen(callback)}, config.timeout);
        } else {
            winston.info("Listening to generator!")
            res.on('data', function (buf) {
                try {
                    bytes_in_month += buf.length
                    for (l in listeners) {
                        listeners[l].write(buf);
                        bytes_out_month += buf.length;
                        if (peaks['bytes_out_month'] < bytes_out_month)
                            peaks['bytes_out_month'] = bytes_out_month;
                    }
                    if ( __transfer_exceeded ) {
                        winston.error("Maximum uplink exceeded! Shutting off.");
                        for (l in listeners) listeners[l].end();
                        req.destroy();
                    }
                } catch (err) {
                    winston.error("Could not send to listeners: " + err);
                }
            });
            res.on('end', function () {
                if ( !transfer_exceeded() ) {
                    winston.error("Stream ended! Restarting listener...");
                    setTimeout(function(){listen(function(){})}, config.timeout);
                }
            });
            if (typeof callback != "undefined") callback();
        }
    })
    req.end();
}

var ipof = function(req) {
    var ipAddress;
    var forwardedIpsStr = req.headers['x-forwarded-for']; 
    if (forwardedIpsStr) {
        var forwardedIps = forwardedIpsStr.split(',');
        ipAddress = forwardedIps[0];
    }
    if (!ipAddress) {
        ipAddress = req.connection.remoteAddress;
    }
    return ipAddress;
};

var available = function(response) {
    if ( transfer_exceeded() ) {
        winston.error("Max transfer exceeded: returning 301.");
        response.writeHead(301, {'Location': "http://" + options.hostname + options.path})
        response.end();
        return false;
    }
    if ( listeners.length + 1 > config.listener_limit ) {
        winston.error("Listener limit exceeded: returning 503.");
        response.writeHead(503);
        response.end();
        return false;
    } 
    return true;
}

var run = function() {
    winston.info("Starting server.")
    http.createServer(function(request, response) {
        request.ip = ipof(request);
        try {
            switch (request.url) {
                case "/all.mp3":
                    switch (request.method) {
                        case "GET":
                            if (available(response)) { 
                                response.writeHead(200, {'Content-Type': 'audio/mpeg'});
                                response.on('close', function () {
                                    winston.info("Removed listener: " + request.ip);
                                    listeners.splice(listeners.indexOf(response), 1);
                                });
                                listeners.push(response);
                                if (peaks['listeners'] < listeners.length)
                                    peaks['listeners'] = listeners.length;
                                winston.info("Added listener: " + request.ip);
                            }
                            break;
                        case "HEAD":
                            if (available(response)) {
                                response.writeHead(200, {'Content-Type': 'audio/mpeg'});
                                winston.info("Ending HEAD.");
                                response.end();
                            }
                            break;
                    }
                    break;
                case "/":
                    response.write(JSON.stringify({
                        listeners: listeners.length,
                        bytes_in_month: bytes_in_month,
                        bytes_out_month: bytes_out_month,
                        started_at: started,
                        config: config,
                        peaks: peaks
                    }));
                    response.end();
                    break;
                case "/favicon.ico":
                    response.end();
            }
        } catch (err) {
            winston.error(err);
        }
    }).listen(config.port);
}

switch (process.argv[2]) {
    case "start":
        check(function() {
            daemon.start();
        });
        break;
    case "stop":
        daemon.stop();
        break;
    default:
        check(function() {
          listen();
          run();
        });
}

