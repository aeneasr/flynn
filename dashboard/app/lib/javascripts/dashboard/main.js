(function () {

"use strict";

window.Dashboard = {
	Stores: {},
	Views: {
		Models: {},
		Helpers: {}
	},
	Actions: {},
	routers: {},
	config: {},

	waitForRouteHandler: Promise.resolve(),

	run: function () {
		var loadURL = function() {
			Marbles.history.loadURL();
		};

		if ( Marbles.history && Marbles.history.started ) {
			throw new Error("Marbles.history already started!");
		}

		this.client = new this.Client(this.config.endpoints);

		if (this.config.user && this.config.user.auths.github) {
			Dashboard.githubClient = new this.GithubClient(
				this.config.user.auths.github.access_token
			);
		}

		this.navEl = document.getElementById("nav");
		this.el = document.getElementById("main");
		this.secondaryEl = document.getElementById("secondary");

		this.__secondary = false;

		Marbles.History.start({
			root: (this.config.PATH_PREFIX || '') + '/',
			dispatcher: this.Dispatcher,
			trigger: false
		});

		if (this.config.INSTALL_CERT) {
			// catch should actually never get called.
			this.__isCertInstalled().then(loadURL).catch(loadURL);
			return;
		}

		loadURL();
	},

	__renderNavComponent: function () {
		this.nav = React.render(React.createElement(this.Views.Nav, {
				authenticated: this.config.authenticated
			}), this.navEl);
	},

	__isLoginPath: function (path) {
		path = path || Marbles.history.path;
		if ( path === "" ) {
			return false;
		}
		return String(path).substr(0, 5) === 'login';
	},

	__redirectToLogin: function () {
		var redirectPath = Marbles.history.path ? '?redirect='+ encodeURIComponent(Marbles.history.path) : '';
		Marbles.history.navigate('login'+ redirectPath);
	},

	__catchInsecurePingResponse: function(httpsArgs) {
		var httpsXhr = httpsArgs[1], self = this,
			handleSuccess, handleError, p;

		handleSuccess = function (httpArgs) {
			var httpXhr = httpArgs[1];
			// https did not work but http did...something is wrong with the cert
			self.Dispatcher.handleAppEvent({
				name: "HTTPS_CERT_MISSING",
				status: httpXhr.status
			});
		};
		handleError = function (httpArgs) {
			var httpXhr = httpArgs[1];
			if (httpXhr.status === 0) {
				// https is failing as well...service is unavailable
				self.Dispatcher.handleAppEvent({
					name: "SERVICE_UNAVAILABLE",
					status: httpXhr.status
				});
			}
			// https did not work but http did without a network error
			// => missing ssl exception for controller
			self.Dispatcher.handleAppEvent({
				name: "HTTPS_CERT_MISSING",
				status: httpXhr.status
			});
		};

		if (httpsXhr.status === 0) {
			// https is unavailable, let's see if http works
			self.client.ping("controller", "http").then(handleSuccess).catch(handleError);
			return;
		}
		// an error code other than 0
		self.Dispatcher.handleAppEvent({
			name: "SERVICE_UNAVAILABLE",
			status: httpsXhr.status
		});
	},

	__catchSecurePingResponse: function(args) {
		var xhr = args[1];
		if (xhr.status === 0) {
			// We were not able to access the controller due to a network error (ssl, timeout)
			// In order to understand what's happening, we have to switch to http.
			this.Dispatcher.handleAppEvent({
				name: "CONTROLLER_UNREACHABLE_FROM_HTTPS",
				status: xhr.status
			});
			return;
		}

		// an error code other than 0
		this.Dispatcher.handleAppEvent({
			name: "SERVICE_UNAVAILABLE",
			status: xhr.status
		});
	},

	__successPingResponse: function(args) {
		var xhr = args[1];
		if (xhr.status !== 200) {
			// If we don't make sure that the response was successful, we might end up in an
			// infinite loop.
			return;
		}
		window.location.href = window.location.href.replace("http:", "https:");
	},

	__isCertInstalled: function() {
		var self = this;
		if (window.location.protocol === "https:") {
			return self.client.ping("controller", "https").catch(self.__catchSecurePingResponse.bind(this));
		} else {
			return self.client.ping("controller", "https")
				.then(self.__successPingResponse.bind(this))
				.catch(self.__catchInsecurePingResponse.bind(this));
		}
	},

	__handleEvent: function (event) {
		if (event.source === "Marbles.History") {
			switch (event.name) {
				case "handler:before":
					this.__handleHandlerBeforeEvent(event);
				break;

				case "handler:after":
					this.__handleHandlerAfterEvent(event);
				break;
			}
			return;
		}

		if (event.name === "AUTH_BTN_CLICK") {
			if (Dashboard.config.authenticated) {
				this.client.logout();
			} else if ( !this.__isLoginPath() ) {
				this.__redirectToLogin();
			}
		}

		if (event.source === "APP_EVENT") {
			this.__handleAppEvent(event);
		}
	},

	__handleAppEvent: function (event) {
		switch (event.name) {
			case "CONFIG_READY":
				this.__handleConfigReady();
			break;

			case "AUTH_CHANGE":
				this.__handleAuthChange(event.authenticated);
			break;

			case "GITHUB_AUTH_CHANGE":
				this.__handleGithubAuthChange(event.authenticated);
			break;

			case "CONTROLLER_UNREACHABLE_FROM_HTTPS":
				// Controller isn't accessible via https. Redirect to http and try again.
				window.location.href = window.location.href.replace("https", "http");
			break;

			case "HTTPS_CERT_MISSING":
				Marbles.history.navigate("installcert");
			break;

			case "SERVICE_UNAVAILABLE":
				this.__handleServiceUnavailable(event.status);
			break;
		}
	},

	__handleConfigReady: function () {
		var started = this.__started || false;
		if ( !started ) {
			this.__started = true;
			this.run();
		}
	},

	__handleAuthChange: function (authenticated) {
		this.__renderNavComponent();

		if ( !authenticated && !this.__isLoginPath() ) {
			var currentHandler = Marbles.history.getHandler();
			if (currentHandler && currentHandler.opts.auth === false) {
				// Don't redirect to login from page not requiring auth
				return;
			}
			this.__redirectToLogin();
		}
	},

	__handleGithubAuthChange: function (authenticated) {
		if (authenticated) {
			if ( !Dashboard.githubClient ) {
				var githubAuth = this.config.user.auths.github;
				Dashboard.githubClient = new this.GithubClient(
					githubAuth.access_token
				);
			}
		} else {
			Dashboard.githubClient = null;
		}
	},

	__handleServiceUnavailable: function (status) {
		React.render(
			React.createElement(this.Views.ServiceUnavailable, { status: status }),
			document.getElementById('main')
		);
	},

	__handleHandlerBeforeEvent: function (event) {
		this.waitForRouteHandler = new Promise(function (rs) {
			this.__waitForRouteHandlerResolve = rs;
		}.bind(this));

		this.__renderNavComponent();

		// prevent route handlers requiring auth from being called when app is not authenticated
		if ( !this.config.authenticated && event.handler.opts.auth !== false ) {
			event.abort();
			return;
		}

		if (event.handler.opts.secondary) {
			// view is rendered in a modal
			this.__secondary = true;
			return;
		}

		var path = event.path;

		// don't reset view if only params changed
		var prevPath = Marbles.history.prevPath || "";
		if (path.split('?')[0] === prevPath.split('?')[0]) {
			if (event.handler.opts.paramChangeScrollReset !== false) {
				// reset scroll position
				window.scrollTo(0,0);
			}
			return;
		}

		// don't reset view when navigating between login/reset and login
		if (path.substr(0, 5) === "login" && prevPath.substr(0, 5) === "login") {
			return;
		}

		// unmount main view / reset scroll position
		if ( !event.handler.opts.secondary ) {
			window.scrollTo(0,0);
			this.primaryView = null;
			React.unmountComponentAtNode(this.el);
		}

		// unmount secondary view
		if (this.__secondary) {
			this.__secondary = false;
			React.unmountComponentAtNode(this.secondaryEl);
		}
	},

	__handleHandlerAfterEvent: function () {
		if (this.__waitForRouteHandlerResolve) {
			this.__waitForRouteHandlerResolve();
			this.waitForRouteHandler = Promise.resolve();
		}
	}
};

})();
