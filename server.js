var http = require('http');
var WebSocket = require('faye-websocket');
var pathPrefix = process.env.ROOT_URL_PATH_PREFIX || "";
var _ = require('underscore');
var sockjs = require('sockjs');
var connect = require('connect');
var url = require('url');

var debugLog = process.env.STICKY_DEBUG ? _.bind(console.log, console) : function () {};

var StickyServer = function (stickyOptions) {
  var self = this;
  self.open_sockets = [];

  self.prefix = pathPrefix + '/sockjs';

  // set up sockjs
  var options = {
    prefix: self.prefix,
    log: function() {},
    // this is the default, but we code it explicitly because we depend
    // on it in stream_client:HEARTBEAT_TIMEOUT
    heartbeat_delay: 45000,
    // The default disconnect_delay is 5 seconds, but if the server ends up CPU
    // bound for that much time, SockJS might not notice that the user has
    // reconnected because the timer (of disconnect_delay ms) can fire before
    // SockJS processes the new connection. Eventually we'll fix this by not
    // combining CPU-heavy processing with SockJS termination (eg a proxy which
    // converts to Unix sockets) but for now, raise the delay.
    disconnect_delay: 60 * 1000,
    // Set the USE_JSESSIONID environment variable to enable setting the
    // JSESSIONID cookie. This is useful for setting up proxies with
    // session affinity.
    //jsessionid: !!process.env.USE_JSESSIONID
    jsessionid : true,
    websocket  : false, // don't waste time for those; these guys should bypass the proxy server
  };

  // If you know your server environment (eg, proxies) will prevent websockets
  // from ever working, set $DISABLE_WEBSOCKETS and SockJS clients (ie,
  // browsers) will not waste time attempting to use them.
  // (Your server will still have a /websocket endpoint.)
  //if (process.env.DISABLE_WEBSOCKETS)
  //  options.websocket = false;

  self.server = sockjs.createServer(options);

  self.middleware = function () {
    return self.server.middleware();
  };

  //Package.webapp.WebApp.httpServer.on('meteor-closing', function () {
  //  _.each(self.open_sockets, function (socket) {
  //    socket.end();
  //  });
  //});

  // we don't support the /websocket endpoint
  //self._redirectWebsocketEndpoint();

  self.server.on('connection', function (socket) {

    // XXX the ping option is critical! without this, the proxy might be disconnected due
    //     due to load balancer timeouts!!! and we would need to resend all data every few seconds
    var proxy = new WebSocket.Client(stickyOptions.endpoint, [], { ping: 1 });

    self.open_sockets.push(socket);

    // ORIGINAL SOCKET

    socket.on('close', function () {
      debugLog('closing client');
      self.open_sockets = _.without(self.open_sockets, socket);
      proxy && proxy.close();
      socket = null;
    });

    socket.on('data', function(message) {
      debugLog('=>', message);
      proxy && proxy.send(message);
    });

    // PROXY EVENTS

    proxy.on('open', function () {
      self.open_sockets.push(proxy);
    });

    proxy.on('close', function (event) {
      debugLog('closing proxy connection');
      self.open_sockets = _.without(self.open_sockets, proxy);
      // XXX I am not 100% sure we should close it, what about reconnecting?
      socket && socket.close(event.code, event.reason);
      proxy = null;
    });

    proxy.on('message', function(event) {
      debugLog('<=', event.data);
      socket && socket.write(event.data);
    });

  });

};

_.extend(StickyServer.prototype, {

  // get a list of all sockets
  all_sockets: function () {
    var self = this;
    return _.values(self.open_sockets);
  },

});

//-----------------------------------------

var server = new StickyServer({
  endpoint: process.env.STICKY_ENDPOINT
});

var endpointHost =  url.parse(process.env.STICKY_ENDPOINT).host;

var app = connect()
  .use(function (req, res, next) {
    if (url.parse(req.headers.origin).host !== endpointHost) {
      res.statusCode = 403;
      res.end();
    } else {
      next();
    }
  })
  .use(server.middleware());

http.createServer(app).listen(process.env.PORT);


