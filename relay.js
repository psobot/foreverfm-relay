//  Forever.fm relay server
//  Simple, lightweight, untested.

var config = require('./config.json');
var stats = require('./stats.json');

var http = require('http');
var url = require('url');
var fs = require('fs');
var winston = require('winston');
var daemon = require("daemonize2").setup({
    main: "relay.js",
    name: "relay",
    pidfile: "relay.pid"
});

var options = {
    hostname: process.env.URL || "forever.fm",
    path: "/all.mp3",
    port: 80,
    headers: {
      "Connection": "keep-alive",
      'User-Agent': 'foreverfm-relay',
      'X-Relay-Addr': process.env.RELAY_URL || config.relay_url,
      'X-Relay-Port': config.relay_port
    }
};
var listeners = [];
var started = +new Date; 
if (stats.month < 0) stats.month = (new Date()).getMonth()

var crossdomain = "";
fs.readFile('./crossdomain.xml', function(error, content) {
    if (!error) crossdomain = content;
});

var __transfer_exceeded = false;
var transfer_exceeded = function() {
    cur_month = (new Date()).getMonth();
    if (stats.month != cur_month) {
        stats.month = cur_month;
        stats.bytes_out_month = 0;
        stats.bytes_in_month = 0;
    }
    __transfer_exceeded = stats.bytes_out_month > config.max_monthly_transfer;
    return __transfer_exceeded;
}

var shutdown = false;

var logger = new (winston.Logger)({
    transports: [
        new winston.transports.Console(
            {
                colorize: true,
                timestamp: true,
                handleExceptions: true
            }),
        new winston.transports.File(
            {
                level: 'info',
                colorize: false,
                timestamp: true,
                json: false,
                filename: 'relay.log',
                handleExceptions: true
            })
    ]
});

var check = function(callback) {
    logger.info("Attempting to connect to generator...");

    check_opts = {'method': 'HEAD'};
    for (var a in options) check_opts[a] = options[a];
    req = http.request(check_opts, function (res) {
        if ( res.statusCode != 200 && res.statusCode != 405 ) {
            logger.error("OH NOES: Got a " + res.statusCode);
        } else {
            logger.info("Got response back from generator!")
            if (typeof callback != "undefined") callback();
        }
    })
    req.end();
}

var listen = function(callback) {
    logger.info("Attempting to listen to generator...");
    req = http.request(options, function (res) {
        if ( res.statusCode != 200 ) {
            logger.error("OH NOES: Got a " + res.statusCode);
            setTimeout(function(){listen(callback)}, config.timeout);
        } else {
            logger.info("Listening to generator!")
            res.on('data', function (buf) {
                try {
                    stats.bytes_in_month += buf.length
                    for (l in listeners) {
                        listeners[l].write(buf);
                        stats.bytes_out_month += buf.length;
                        if (stats.peaks.bytes_out_month < stats.bytes_out_month)
                            stats.peaks.bytes_out_month = stats.bytes_out_month;
                    }
                    if ( __transfer_exceeded ) {
                        logger.error("Maximum uplink exceeded! Shutting off.");
                        for (l in listeners) listeners[l].end();
                        req.destroy();
                    }
                } catch (err) {
                    logger.error("Could not send to listeners: " + err);
                }
            });
            res.on('end', function () {
                if ( !transfer_exceeded() ) {
                    logger.error("Stream ended! Restarting listener...");
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
    if ( transfer_exceeded() || shutdown ) {
        logger.warning("Returning 301, redirecting to " + config.redirect + ".");
        response.writeHead(301, {'Location': config.redirect})
        response.end();
        return false;
    }
    if ( listeners.length + 1 > config.listener_limit ) {
        logger.error("Listener limit exceeded: returning 503.");
        response.writeHead(503);
        response.end();
        return false;
    } 
    return true;
}

var prune = function() {
    limit = (+new Date) - config.heartbeat_interval;
    remove = [];
    for (l in listeners) {
        if (listeners[l].last_heartbeat != null) {
            if (listeners[l].last_heartbeat < limit) {
                logger.info(listeners[l].last_heartbeat);
                logger.info("Listener " + listeners[l].ip + " has missed a heartbeat.");
                remove.push(listeners[l]);
            }
        } else if (listeners[l].checked) {
            logger.info("Listener " + listeners[l].ip + " has not provided any heartbeats.");
            remove.push(listeners[l]);
        }
        listeners[l].checked = true;
    }
    if (remove.length > 0)
        logger.info("Removing " + remove.length + " listeners.");

    for (r in remove) {
        remove[r].end();
        listeners.splice(listeners.indexOf(remove[r]), 1);
    }
}

var save = function() {
    fs.writeFile("./stats.json", JSON.stringify(stats), function(err) {
        if (err) logger.error("Could not save statistics due to: " + err);
    });

    fs.stat("./shutdown.txt", function( err, stats ) {
        if ( err != null || stats == null ) {
            logger.error("Could not fstat shutdown.txt.");
            return;
        }
        if ( ( +new Date( stats.mtime ) ) > started ) {
            if ( !shutdown ) {
                logger.info("Initiating shutdown due to shutdown.txt modification!");
                shutdown = true;
            } else if ( listeners.length == 0 ) {
                logger.info("Zero listeners. Shutting down. Goodbye!");
                process.exit(0);
            }
        }
    });
}

var run = function() {
    logger.info("Starting server.")

    if ( config.heartbeat_required ) setInterval( prune, config.heartbeat_interval );
    setInterval( save, config.save_interval );

    http.createServer(function(request, response) {
        request.ip = ipof(request);
        response.ip = request.ip;
        try {
            switch (request.url) {
                case "/all.mp3":
                    switch (request.method) {
                        case "GET":
                            if (available(response)) { 
                                response.writeHead(200, {'Content-Type': 'audio/mpeg'});
                                response.on('close', function () {
                                    logger.info("Removed listener: " + request.ip);
                                    listeners.splice(listeners.indexOf(response), 1);
                                });
                                listeners.push(response);
                                if (stats.peaks.listeners < listeners.length)
                                    stats.peaks.listeners = listeners.length;
                                logger.info("Added listener: " + request.ip);
                            }
                            break;
                        case "HEAD":
                            if (available(response)) {
                                response.writeHead(200, {'Content-Type': 'audio/mpeg'});
                                response.end();
                            }
                            break;
                    }
                    break;
                case "/":
                    response.write(JSON.stringify({
                        listeners: listeners.length,
                        bytes_in_month: stats.bytes_in_month,
                        bytes_out_month: stats.bytes_out_month,
                        started_at: started,
                        config: config,
                        peaks: stats.peaks
                    }));
                    response.end();
                    break;
                case "/crossdomain.xml":
                    response.writeHead(200, {'Content-Type': 'text/xml'});
                    response.write(crossdomain);
                    response.end();
                    break;
                default:
                    if ( request.url.indexOf("/heartbeat") == 0 ) {
                        if ( config.heartbeat_required ) {
                            for (l in listeners) {
                                if (listeners[l].ip == request.ip) {
                                    listeners[l].last_heartbeat = (+new Date);
                                    break;
                                }
                            }
                        }
                        response.writeHead(200, {'Content-Type': 'text/javascript'});
                        callback = url.parse(request.url, true).query.callback;
                        if (callback) response.write(callback + "(" + config.heartbeat_required + ");");
                    } else {
                        response.writeHead(404);
                    }
                    response.end();
                    break;
            }
        } catch (err) {
            logger.error(err);
        }
    }).listen(process.env.PORT || config.port);
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

