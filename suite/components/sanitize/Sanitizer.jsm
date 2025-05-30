// -*- indent-tabs-mode: nil; js-indent-level: 2 -*-
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

var EXPORTED_SYMBOLS = ["Sanitizer"];

const {XPCOMUtils} = ChromeUtils.import("resource://gre/modules/XPCOMUtils.jsm");

XPCOMUtils.defineLazyModuleGetters(this, {
  AppConstants: "resource://gre/modules/AppConstants.jsm",
  console: "resource://gre/modules/Console.jsm",
  Downloads: "resource://gre/modules/Downloads.jsm",
  DownloadsCommon: "resource:///modules/DownloadsCommon.jsm",
  FormHistory: "resource://gre/modules/FormHistory.jsm",
  PlacesUtils: "resource://gre/modules/PlacesUtils.jsm",
  setTimeout: "resource://gre/modules/Timer.jsm",
  OfflineAppCacheHelper: "resource://gre/modules/offlineAppCache.jsm",
});

XPCOMUtils.defineLazyServiceGetter(this, "serviceWorkerManager",
                                   "@mozilla.org/serviceworkers/manager;1",
                                   "nsIServiceWorkerManager");
XPCOMUtils.defineLazyServiceGetter(this, "quotaManagerService",
                                   "@mozilla.org/dom/quota-manager-service;1",
                                   "nsIQuotaManagerService");

// Used as unique id for pending sanitizations.
var gPendingSanitizationSerial = 0;

/**
 * A number of iterations after which to yield time back
 * to the system.
 */
const YIELD_PERIOD = 10;

var Sanitizer = {
  /**
   * Whether we should sanitize on shutdown.
   */
  PREF_SANITIZE_ON_SHUTDOWN: "privacy.sanitize.sanitizeOnShutdown",

  /**
   * During a sanitization this is set to a JSON containing an array of the
   * pending sanitizations. This allows to retry sanitizations on startup in
   * case they dind't run or were interrupted by a crash.
   * Use addPendingSanitization and removePendingSanitization to manage it.
   */
  PREF_PENDING_SANITIZATIONS: "privacy.sanitize.pending",

  /**
   * Pref branches to fetch sanitization options from.
   */
  PREF_CPD_BRANCH: "privacy.cpd.",
  PREF_SHUTDOWN_BRANCH: "privacy.clearOnShutdown.",

  /**
   * The fallback timestamp used when no argument is given to
   * Sanitizer.getClearRange.
   */
  PREF_TIMESPAN: "privacy.sanitize.timeSpan",

  /**
   * Time span constants corresponding to values of the preference
   * privacy.sanitize.timeSpan It is used to determine how much history
   * to clear, for various items.
   */
  TIMESPAN_EVERYTHING: 0,
  TIMESPAN_HOUR:       1,
  TIMESPAN_2HOURS:     2,
  TIMESPAN_4HOURS:     3,
  TIMESPAN_TODAY:      4,
  TIMESPAN_5MIN:       5,
  TIMESPAN_24HOURS:    6,

  /**
   * Whether we should sanitize on shutdown.
   * When this is set, a pending sanitization should also be added and removed
   * when shutdown sanitization is complete. This allows to retry incomplete
   * sanitizations on startup.
   */
  shouldSanitizeOnShutdown: false,

  /**
   * Shows a sanitization dialog to the user.
   *
   * @param [optional] parentWindow the window to use as
   *                   parent for the created dialog.
   */
  showUI(parentWindow) {
    let win = AppConstants.platform == "macosx" ?
      null : // make this an app-modal window on Mac
      parentWindow;
    Services.ww.openWindow(win,
                           "chrome://communicator/content/sanitizeDialog.xul",
                           "Sanitize",
                           "chrome,titlebar,centerscreen,dialog,modal",
                           null);
  },

  /**
   * Performs startup tasks:
   *  - Checks if sanitizations were not completed during the last session.
   *  - Registers sanitize-on-shutdown.
   */
  async onStartup() {
    // First, collect pending sanitizations from the last session, before we
    // add pending sanitizations for this session.
    let pendingSanitizations = getAndClearPendingSanitizations();

    // Check if we should sanitize on shutdown.
    this.shouldSanitizeOnShutdown =
      Services.prefs.getBoolPref(Sanitizer.PREF_SANITIZE_ON_SHUTDOWN, false);
    Services.prefs.addObserver(Sanitizer.PREF_SANITIZE_ON_SHUTDOWN, this,
                               true);
    // Add a pending shutdown sanitization, if necessary.
    if (this.shouldSanitizeOnShutdown) {
      let itemsToClear =
        getItemsToClearFromPrefBranch(Sanitizer.PREF_SHUTDOWN_BRANCH);
      addPendingSanitization("shutdown", itemsToClear, {});
    }
    // Shutdown sanitization is always pending, but the user may change the
    // sanitize on shutdown prefs during the session. Then the pending
    // sanitization would become stale and must be updated.
    Services.prefs.addObserver(Sanitizer.PREF_SHUTDOWN_BRANCH, this, true);

    // Make sure that we are triggered during shutdown.
    let shutdownClient = PlacesUtils.history.shutdownClient.jsclient;
    // We need to pass to sanitize() (through sanitizeOnShutdown) a state
    // object that tracks the status of the shutdown blocker. This 'progress'
    // object will be updated during sanitization and reported with the crash
    // in case of a shutdown timeout.
    // We use the `options` argument to pass the `progress` object to
    // sanitize().
    let progress = { isShutdown: true };
    shutdownClient.addBlocker("sanitize.js: Sanitize on shutdown",
      () => sanitizeOnShutdown(progress),
      {fetchState: () => ({ progress })}
    );

    // Finally, run the sanitizations that were left pending, because we
    // crashed before completing them.
    for (let {itemsToClear, options} of pendingSanitizations) {
      try {
        await this.sanitize(itemsToClear, options);
      } catch (ex) {
        Cu.reportError("A previously pending sanitization failed: " +
                       itemsToClear + "\n" + ex);
      }
    }
  },

  /**
   * Returns a 2 element array representing the start and end times,
   * in the uSec-since-epoch format that PRTime likes. If we should
   * clear everything, this function returns null.
   *
   * @param ts [optional] a timespan to convert to start and end time.
   *                      Falls back to the privacy.sanitize.timeSpan
   *                      preference if this argument is omitted.
   *                      If this argument is provided, it has to be one of the
   *                      Sanitizer.TIMESPAN_* constants. This function will
   *                      throw an error otherwise.
   *
   * @return {Array} a 2-element Array containing the start and end times.
   */
  getClearRange(ts) {
    if (ts === undefined)
      ts = Services.prefs.getIntPref(Sanitizer.PREF_TIMESPAN);
    if (ts === Sanitizer.TIMESPAN_EVERYTHING)
      return null;

    // PRTime is microseconds while JS time is milliseconds
    var endDate = Date.now() * 1000;
    switch (ts) {
      case Sanitizer.TIMESPAN_5MIN :
        // 5*60*1000000
        var startDate = endDate - 300000000;
        break;
      case Sanitizer.TIMESPAN_HOUR :
        // 1*60*60*1000000
        startDate = endDate - 3600000000;
        break;
      case Sanitizer.TIMESPAN_2HOURS :
        // 2*60*60*1000000
        startDate = endDate - 7200000000;
        break;
      case Sanitizer.TIMESPAN_4HOURS :
        // 4*60*60*1000000
        startDate = endDate - 14400000000;
        break;
      case Sanitizer.TIMESPAN_TODAY :
        // Start with today
        var d = new Date();
        // zero us back to midnight...
        d.setHours(0);
        d.setMinutes(0);
        d.setSeconds(0);
        // convert to epoch usec
        startDate = d.valueOf() * 1000;
        break;
      case Sanitizer.TIMESPAN_24HOURS :
        // 24*60*60*1000000
        startDate = endDate - 86400000000;
        break;
      default:
        throw "Invalid time span for clear private data: " + ts;
    }
    return [startDate, endDate];
  },

  /**
   * Deletes privacy sensitive data in a batch, according to user preferences.
   * Returns a promise which is resolved if no errors occurred.  If an error
   * occurs, a message is reported to the console and all other items are still
   * cleared before the promise is finally rejected.
   *
   * @param [optional] itemsToClear
   *        Array of items to be cleared. if specified only those
   *        items get cleared, irrespectively of the preference settings.
   * @param [optional] options
   *        Object whose properties are options for this sanitization:
   *         - ignoreTimespan (default: true): Time span only makes sense in
   *           certain cases.  Consumers who want to only clear some private
   *           data can opt in by setting this to false, and can optionally
   *           specify a specific range.
   *           If timespan is not ignored, and range is not set, sanitize()
   *           will use the value of the timespan pref to determine a range.
   *         - range (default: null)
   *         - privateStateForNewWindow (default: "non-private"): when clearing
   *           open windows, defines the private state for the newly opened
   *           window.
   */
  async sanitize(itemsToClear = null, options = {}) {
    let progress = options.progress || {};
    if (!itemsToClear)
      itemsToClear = getItemsToClearFromPrefBranch(this.PREF_CPD_BRANCH);
    let promise = sanitizeInternal(this.items, itemsToClear, progress,
                                   options);

    // Depending on preferences, the sanitizer may perform asynchronous
    // work before it starts cleaning up the Places database (e.g. closing
    // windows). We need to make sure that the connection to that database
    // hasn't been closed by the time we use it.
    // Though, if this is a sanitize on shutdown, we already have a blocker.
    if (!progress.isShutdown) {
      let shutdownClient = Cc["@mozilla.org/browser/nav-history-service;1"]
                             .getService(Ci.nsPIPlacesDatabase)
                             .shutdownClient
                             .jsclient;
      shutdownClient.addBlocker("sanitize.js: Sanitize",
        promise,
        {
          fetchState: () => ({ progress })
        }
      );
    }

    try {
      await promise;
    } finally {
      Services.obs.notifyObservers(null, "sanitizer-sanitization-complete");
    }
  },

  observe(subject, topic, data) {
    if (topic == "nsPref:changed") {
      if (data.startsWith(this.PREF_SHUTDOWN_BRANCH) &&
          this.shouldSanitizeOnShutdown) {
        // Update the pending shutdown sanitization.
        removePendingSanitization("shutdown");
        let itemsToClear =
          getItemsToClearFromPrefBranch(Sanitizer.PREF_SHUTDOWN_BRANCH);
        addPendingSanitization("shutdown", itemsToClear, {});
      } else if (data == this.PREF_SANITIZE_ON_SHUTDOWN) {
        this.shouldSanitizeOnShutdown =
          Services.prefs.getBoolPref(Sanitizer.PREF_SANITIZE_ON_SHUTDOWN,
                                     false);
        removePendingSanitization("shutdown");
        if (this.shouldSanitizeOnShutdown) {
          let itemsToClear =
            getItemsToClearFromPrefBranch(Sanitizer.PREF_SHUTDOWN_BRANCH);
          addPendingSanitization("shutdown", itemsToClear, {});
        }
      }
    }
  },

  QueryInterface: ChromeUtils.generateQI([
    Ci.nsiObserver,
    Ci.nsISupportsWeakReference,
  ]),

  items: {
    cache: {
      async clear(range) {
        let seenException;

        try {
          // Cache doesn't consult timespan, nor does it have the
          // facility for timespan-based eviction.  Wipe it.
          Services.cache2.clear();
        } catch (ex) {
          seenException = ex;
        }

        try {
          let imageCache = Cc["@mozilla.org/image/tools;1"]
                             .getService(Ci.imgITools)
                             .getImgCacheForDocument(null);
          // clearCache: true=chrome, false=content.
          imageCache.clearCache(false);
        } catch (ex) {
          seenException = ex;
        }

        if (seenException) {
          throw seenException;
        }
      }
    },

    cookies: {
      async clear(range) {
        let seenException;
        let yieldCounter = 0;

        // Clear cookies.
        try {
          if (range) {
            // Iterate through the cookies and delete any created after our
            // cutoff.
            let cookiesEnum = Services.cookies.enumerator;
            while (cookiesEnum.hasMoreElements()) {
              let cookie = cookiesEnum.getNext().QueryInterface(Ci.nsICookie2);

              if (cookie.creationTime > range[0]) {
                // This cookie was created after our cutoff, clear it
                Services.cookies.remove(cookie.host, cookie.name, cookie.path,
                                        false, cookie.originAttributes);

                if (++yieldCounter % YIELD_PERIOD == 0) {
                  // Don't block the main thread too long
                  await new Promise(resolve => setTimeout(resolve, 0));
                }
              }
            }
          } else {
            // Remove everything
            Services.cookies.removeAll();
            // Don't block the main thread too long
            await new Promise(resolve => setTimeout(resolve, 0));
          }
        } catch (ex) {
          seenException = ex;
        }

        // Clear deviceIds. Done asynchronously (returns before complete).
        try {
          let mediaMgr = Cc["@mozilla.org/mediaManagerService;1"]
                           .getService(Ci.nsIMediaManagerService);
          mediaMgr.sanitizeDeviceIds(range && range[0]);
        } catch (ex) {
          seenException = ex;
        }

        if (seenException) {
          throw seenException;
        }
      },
    },

    offlineApps: {
      async clear(range) {
        // This doesn't wait for the cleanup to be complete.
        OfflineAppCacheHelper.clear();

        // LocalStorage
        Services.obs.notifyObservers(null, "extension:purge-localStorage");

        // ServiceWorkers
        let promises = [];
        let serviceWorkers = serviceWorkerManager.getAllRegistrations();
        for (let i = 0; i < serviceWorkers.length; i++) {
          let sw = serviceWorkers
            .queryElementAt(i, Ci.nsIServiceWorkerRegistrationInfo);

          promises.push(new Promise(resolve => {
            let unregisterCallback = {
              unregisterSucceeded: () => { resolve(true); },
              // We don't care about failures.
              unregisterFailed: () => { resolve(true); },
              QueryInterface: ChromeUtils.generateQI(
                [Ci.nsIServiceWorkerUnregisterCallback]),
            };

            serviceWorkerManager.propagateUnregister(sw.principal,
                                                     unregisterCallback,
                                                     sw.scope);
          }));
        }

        await Promise.all(promises);

        // QuotaManager
        promises = [];
        await new Promise(resolve => {
          quotaManagerService.getUsage(request => {
            if (request.resultCode != Cr.NS_OK) {
              // We are probably shutting down. We don't want to propagate the
              // error, rejecting the promise.
              resolve();
              return;
            }

            for (let item of request.result) {
              let principal =
                Services.scriptSecurityManager
                        .createCodebasePrincipalFromOrigin(item.origin);
              let uri = principal.URI;
              if (uri.scheme == "http" || uri.scheme == "https" ||
                  uri.scheme == "file") {
                promises.push(new Promise(r => {
                  let req =
                    quotaManagerService.clearStoragesForPrincipal(principal,
                                                                  null, false);
                  req.callback = () => { r(); };
                }));
              }
            }
            resolve();
          });
        });

        return Promise.all(promises);
      }
    },

    history: {
      async clear(range) {
        let seenException;
        try {
          if (range) {
            await PlacesUtils.history.removeVisitsByFilter({
              beginDate: new Date(range[0] / 1000),
              endDate: new Date(range[1] / 1000)
            });
          } else {
            // Remove everything.
            await PlacesUtils.history.clear();
          }
        } catch (ex) {
          seenException = ex;
        }

        try {
          let clearStartingTime = range ? String(range[0]) : "";
          Services.obs.notifyObservers(null, "browser:purge-session-history",
                                       clearStartingTime);
        } catch (ex) {
          seenException = ex;
        }

        try {
          let predictor = Cc["@mozilla.org/network/predictor;1"]
                            .getService(Ci.nsINetworkPredictor);
          predictor.reset();
        } catch (ex) {
          seenException = ex;
        }

        if (seenException) {
          throw seenException;
        }
      }
    },

    urlbar: {
      async clear(range) {
        let seenException;
        // Clear last URL of the Open Web Location dialog
        try {
          Services.prefs.clearUserPref("general.open_location.last_url");
        } catch(ex) {}

        try {
          // Clear URLbar history (see also pref-history.js)
          let file = Services.dirsvc.get("ProfD", Ci.nsIFile);
          file.append("urlbarhistory.sqlite");
          if (file.exists()) {
            file.remove(false);
          }
        } catch (ex) {
          seenException = ex;
        }
        if (seenException) {
          throw seenException;
        }
      }
    },

    formdata: {
      async clear(range) {
        let seenException;
        try {
          // Clear undo history of all search and find bars.
          let windows = Services.wm.getEnumerator("navigator:browser");
          while (windows.hasMoreElements()) {
            let win = windows.getNext();
            let currentDocument = win.document;

            let findBar = currentDocument.getElementById("FindToolbar");
            if (findBar) {
              findBar.clear();
            }
            // searchBar.textbox may not exist due to the search bar binding
            // not having been constructed yet if the search bar is in the
            // overflow or menu panel. It won't have a value or edit history in
            // that case.
            let searchBar = currentDocument.getElementById("searchbar");
            if (searchBar && searchBar.textbox) {
              searchBar.textbox.reset();
            }

            let sideSearchBar = win.BrowserSearch.searchSidebar;
            if (sideSearchBar) {
              sideSearchBar.reset();
            }
          }
        } catch (ex) {
          seenException = ex;
        }

        try {
          let change = { op: "remove" };
          if (range) {
            [ change.firstUsedStart, change.firstUsedEnd ] = range;
          }
          await new Promise(resolve => {
            FormHistory.update(change, {
              handleError(e) {
                seenException = new Error("Error " + e.result + ": " +
                                          e.message);
              },
              handleCompletion() {
                resolve();
              }
            });
          });
        } catch (ex) {
          seenException = ex;
        }

        if (seenException) {
          throw seenException;
        }
      }
    },

    downloads: {
      async clear(range) {
        try {
          let filterByTime = null;
          if (range) {
            // Convert microseconds back to milliseconds for date comparisons.
            let rangeBeginMs = range[0] / 1000;
            let rangeEndMs = range[1] / 1000;
            filterByTime = download => download.startTime >= rangeBeginMs &&
                                       download.startTime <= rangeEndMs;
          }

          // Clear all completed/cancelled downloads
          let list = await Downloads.getList(Downloads.ALL);
          list.removeFinished(filterByTime);
        } catch (ex) {}
      }
    },

    passwords: {
      async clear(range) {
        try {
          Services.logins.removeAllLogins();
        } catch (ex) {}
      }
    },

    sessions: {
      async clear(range) {
        try {
          // clear all auth tokens
          let sdr = Cc["@mozilla.org/security/sdr;1"]
                      .getService(Ci.nsISecretDecoderRing);
          sdr.logoutAndTeardown();

          // clear FTP and plain HTTP auth sessions
          Services.obs.notifyObservers(null, "net:clear-active-logins");
        } catch (ex) {}
      }
    },

    siteSettings: {
      async clear(range) {
        let seenException;

        let startDateMS = range ? range[0] / 1000 : null;

        try {
          // Clear site-specific permissions like 
          // "Allow this site to open popups".
          // We ignore the "end" range and hope it is now() - none of the
          // interfaces used here support a true range anyway.
          if (startDateMS == null) {
            Services.perms.removeAll();
          } else {
            Services.perms.removeAllSince(startDateMS);
          }
        } catch (ex) {
          seenException = ex;
        }

        try {
          // Clear site-specific settings like page-zoom level
          let cps = Cc["@mozilla.org/content-pref/service;1"]
                      .getService(Ci.nsIContentPrefService2);
          if (startDateMS == null) {
            cps.removeAllDomains(null);
          } else {
            cps.removeAllDomainsSince(startDateMS, null);
          }
        } catch (ex) {
          seenException = ex;
        }

        try {
          // Clear site security settings - no support for ranges in this
          // interface either, so we clearAll().
          let sss = Cc["@mozilla.org/ssservice;1"]
                      .getService(Ci.nsISiteSecurityService);
          sss.clearAll();
        } catch (ex) {
          seenException = ex;
        }

        // Clear all push notification subscriptions
        try {
          await new Promise((resolve, reject) => {
            let push = Cc["@mozilla.org/push/Service;1"]
                         .getService(Ci.nsIPushService);
            push.clearForDomain("*", status => {
              if (Components.isSuccessCode(status)) {
                resolve();
              } else {
                reject(new Error("Error clearing push subscriptions: " +
                                 status));
              }
            });
          });
        } catch (ex) {
          seenException = ex;
        }

        if (seenException) {
          throw seenException;
        }
      }
    },

    openWindows: {
      _canCloseWindow(win) {
        if (win.CanCloseWindow()) {
          // We already showed PermitUnload for the window, so let's
          // make sure we don't do it again when we actually close the
          // window.
          win.skipNextCanClose = true;
          return true;
        }
        return false;
      },
      _resetAllWindowClosures(windowList) {
        for (let win of windowList) {
          win.skipNextCanClose = false;
        }
      },
      async clear(range, privateStateForNewWindow = "non-private") {
        // NB: this closes all *browser* windows, not other windows like the
        // library, about window,  browser console, etc.

        // Keep track of the time in case we get stuck in la-la-land because of
        // onbeforeunload dialogs.
        let existingWindow = Services.appShell.hiddenDOMWindow;
        let startDate = existingWindow.performance.now();

        // First check if all these windows are OK with being closed:
        let windowEnumerator = Services.wm.getEnumerator("navigator:browser");
        let windowList = [];
        while (windowEnumerator.hasMoreElements()) {
          let someWin = windowEnumerator.getNext();
          windowList.push(someWin);
          // If someone says "no" to a beforeunload prompt, we abort here:
          if (!this._canCloseWindow(someWin)) {
            this._resetAllWindowClosures(windowList);
            throw new Error("Sanitize could not close windows: " +
                            "cancelled by user");
          }

          // ...however, beforeunload prompts spin the event loop, and so the
          // code here won't get hit until the prompt has been dismissed.
          // If more than 1 minute has elapsed since we started prompting,
          // stop, because the user might not even remember initiating the
          // 'forget', and the timespans will be all wrong by now anyway:
          if (existingWindow.performance.now() > (startDate + 60 * 1000)) {
            this._resetAllWindowClosures(windowList);
            throw new Error("Sanitize could not close windows: timeout");
          }
        }

        // If/once we get here, we should actually be able to close all
        // windows.

        // First create a new window. We do this first so that on non-mac, we
        // don't accidentally close the app by closing all the windows.
        let handler = Cc["@mozilla.org/browser/clh;1"]
                        .getService(Ci.nsIBrowserHandler);
        let defaultArgs = handler.defaultArgs;
        let features = "chrome,all,dialog=no," + privateStateForNewWindow;
        let newWindow = existingWindow.openDialog("chrome://browser/content/",
                                                 "_blank", features,
                                                 defaultArgs);

        let onFullScreen = null;
        if (AppConstants.platform == "macosx") {
          onFullScreen = function(e) {
            newWindow.removeEventListener("fullscreen", onFullScreen);
            let docEl = newWindow.document.documentElement;
            let sizemode = docEl.getAttribute("sizemode");
            if (!newWindow.fullScreen && sizemode == "fullscreen") {
              docEl.setAttribute("sizemode", "normal");
              e.preventDefault();
              e.stopPropagation();
              return false;
            }
            return undefined;
          };
          newWindow.addEventListener("fullscreen", onFullScreen);
        }

        let promiseReady = new Promise(resolve => {
          // Window creation and destruction is asynchronous. We need to wait
          // until all existing windows are fully closed, and the new window is
          // fully open, before continuing. Otherwise the rest of the sanitizer
          // could run too early (and miss new cookies being set when a page
          // closes) and/or run too late (and not have a fully-formed window
          //  yet in existence). See bug 1088137.
          let newWindowOpened = false;
          let onWindowOpened = function(subject, topic, data) {
            if (subject != newWindow)
              return;

            Services.obs.removeObserver(onWindowOpened,
                                        "browser-delayed-startup-finished");
            if (AppConstants.platform == "macosx") {
              newWindow.removeEventListener("fullscreen", onFullScreen);
            }
            newWindowOpened = true;
            // If we're the last thing to happen, invoke callback.
            if (numWindowsClosing == 0) {
              resolve();
            }
          };

          let numWindowsClosing = windowList.length;
          let onWindowClosed = function() {
            numWindowsClosing--;
            if (numWindowsClosing == 0) {
              Services.obs.removeObserver(onWindowClosed,
                                          "xul-window-destroyed");
              // If we're the last thing to happen, invoke callback.
              if (newWindowOpened) {
                resolve();
              }
            }
          };
          Services.obs.addObserver(onWindowOpened,
                                   "browser-delayed-startup-finished");
          Services.obs.addObserver(onWindowClosed, "xul-window-destroyed");
        });

        // Start the process of closing windows
        while (windowList.length) {
          windowList.pop().close();
        }
        newWindow.focus();
        await promiseReady;
      }
    },
  },
};

async function sanitizeInternal(items, aItemsToClear, progress, options = {}) {
  let { ignoreTimespan = true, range } = options;
  let seenError = false;
  // Shallow copy the array, as we are going to modify it in place later.
  if (!Array.isArray(aItemsToClear))
    throw new Error("Must pass an array of items to clear.");
  let itemsToClear = [...aItemsToClear];

  // Store the list of items to clear, in case we are killed before we
  // get a chance to complete.
  let uid = gPendingSanitizationSerial++;
  // Shutdown sanitization is managed outside.
  if (!progress.isShutdown)
    addPendingSanitization(uid, itemsToClear, options);

  // Store the list of items to clear, for debugging/forensics purposes
  for (let k of itemsToClear) {
    progress[k] = "ready";
  }

  // Ensure open windows get cleared first, if they're in our list, so that
  // they don't stick around in the recently closed windows list, and so we
  // can cancel the whole thing if the user selects to keep a window open
  // from a beforeunload prompt.
  let openWindowsIndex = itemsToClear.indexOf("openWindows");
  if (openWindowsIndex != -1) {
    itemsToClear.splice(openWindowsIndex, 1);
    await items.openWindows.clear(null, options);
    progress.openWindows = "cleared";
  }

  // If we ignore timespan, clear everything,
  // otherwise, pick a range.
  if (!ignoreTimespan && !range) {
    range = Sanitizer.getClearRange();
  }

  // For performance reasons we start all the clear tasks at once, then wait
  // for their promises later.
  // Some of the clear() calls may raise exceptions (for example bug 265028),
  // we catch and store them, but continue to sanitize as much as possible.
  // Callers should check returned errors and give user feedback
  // about items that could not be sanitized
  let annotateError = (name, ex) => {
    progress[name] = "failed";
    seenError = true;
    console.error("Error sanitizing " + name, ex);
  };

  // Array of objects in form { name, promise }.
  // `name` is the item's name and `promise` may be a promise, if the
  // sanitization is asynchronous, or the function return value, otherwise.
  let handles = [];
  for (let name of itemsToClear) {
    let item = items[name];
    try {
      // Catch errors here, so later we can just loop through these.
      handles.push({ name,
                     promise: item.clear(range, options)
                                  .then(() => progress[name] = "cleared",
                                        ex => annotateError(name, ex))
                   });
    } catch (ex) {
      annotateError(name, ex);
    }
  }
  for (let handle of handles) {
    progress[handle.name] = "blocking";
    await handle.promise;
  }

  // Sanitization is complete.
  if (!progress.isShutdown)
    removePendingSanitization(uid);
  progress = {};
  if (seenError) {
    throw new Error("Error sanitizing");
  }
}

async function sanitizeOnShutdown(progress) {
  if (!Sanitizer.shouldSanitizeOnShutdown) {
    return;
  }
  // Need to sanitize upon shutdown
  let itemsToClear =
    getItemsToClearFromPrefBranch(Sanitizer.PREF_SHUTDOWN_BRANCH);
  await Sanitizer.sanitize(itemsToClear, { progress });
  // We didn't crash during shutdown sanitization, so annotate it to avoid
  // sanitizing again on startup.
  removePendingSanitization("shutdown");
  Services.prefs.savePrefFile(null);
}

/**
 * Gets an array of items to clear from the given pref branch.
 * @param branch The pref branch to fetch.
 * @return Array of items to clear
 */
function getItemsToClearFromPrefBranch(branch) {
  branch = Services.prefs.getBranch(branch);
  return Object.keys(Sanitizer.items).filter(itemName => {
    try {
      return branch.getBoolPref(itemName);
    } catch (ex) {
      return false;
    }
  });
}

/**
 * These functions are used to track pending sanitization on the next
 * startup in case of a crash before a sanitization could happen.
 * @param id A unique id identifying the sanitization
 * @param itemsToClear The items to clear
 * @param options The Sanitize options
 */
function addPendingSanitization(id, itemsToClear, options) {
  let pendingSanitizations = safeGetPendingSanitizations();
  pendingSanitizations.push({id, itemsToClear, options});
  Services.prefs.setStringPref(Sanitizer.PREF_PENDING_SANITIZATIONS,
                               JSON.stringify(pendingSanitizations));
}
function removePendingSanitization(id) {
  let pendingSanitizations = safeGetPendingSanitizations();
  let i = pendingSanitizations.findIndex(s => s.id == id);
  let [s] = pendingSanitizations.splice(i, 1);
  Services.prefs.setStringPref(Sanitizer.PREF_PENDING_SANITIZATIONS,
    JSON.stringify(pendingSanitizations));
  return s;
}
function getAndClearPendingSanitizations() {
  let pendingSanitizations = safeGetPendingSanitizations();
  if (pendingSanitizations.length)
    Services.prefs.clearUserPref(Sanitizer.PREF_PENDING_SANITIZATIONS);
  return pendingSanitizations;
}
function safeGetPendingSanitizations() {
  try {
    return JSON.parse(
      Services.prefs.getStringPref(Sanitizer.PREF_PENDING_SANITIZATIONS,
                                   "[]"));
  } catch (ex) {
    Cu.reportError("Invalid JSON value for pending sanitizations: " + ex);
    return [];
  }
}
