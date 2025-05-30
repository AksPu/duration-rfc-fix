/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Note: this file is included in aboutDialog.xhtml and preferences/advanced.xhtml
// if MOZ_UPDATER is defined.

/* import-globals-from aboutDialog.js */

var { openLinkExternally } = ChromeUtils.importESModule(
  "resource:///modules/LinkHelper.sys.mjs"
);
var { XPCOMUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/XPCOMUtils.sys.mjs"
);

ChromeUtils.defineESModuleGetters(this, {
  AppUpdater: "resource://gre/modules/AppUpdater.sys.mjs",
  DownloadUtils: "resource://gre/modules/DownloadUtils.sys.mjs",
  UpdateUtils: "resource://gre/modules/UpdateUtils.sys.mjs",
});

XPCOMUtils.defineLazyServiceGetter(
  this,
  "AUS",
  "@mozilla.org/updates/update-service;1",
  "nsIApplicationUpdateService"
);

var UPDATING_MIN_DISPLAY_TIME_MS = 1500;

var gAppUpdater;

function onUnload() {
  if (gAppUpdater) {
    gAppUpdater.destroy();
    gAppUpdater = null;
  }
}

function appUpdater(options = {}) {
  this._appUpdater = new AppUpdater();

  this._appUpdateListener = (status, ...args) => {
    this._onAppUpdateStatus(status, ...args);
  };
  this._appUpdater.addListener(this._appUpdateListener);

  this.options = options;
  this.updatingMinDisplayTimerId = null;
  this.updateDeck = document.getElementById("updateDeck");

  this.bundle = Services.strings.createBundle(
    "chrome://messenger/locale/messenger.properties"
  );

  try {
    const manualURL = new URL(
      Services.urlFormatter.formatURLPref("app.update.url.manual")
    );

    for (const manualLink of document.getElementsByClassName("manualLink")) {
      // Strip hash and search parameters for display text.
      manualLink.textContent = manualURL.origin + manualURL.pathname;
      manualLink.href = manualURL.href;
    }

    document.getElementById("failedLink").href = manualURL.href;
  } catch (e) {
    console.error("Invalid manual update url.", e);
  }

  this._appUpdater.check();
}

appUpdater.prototype = {
  destroy() {
    this.stopCurrentCheck();
    if (this.updatingMinDisplayTimerId) {
      clearTimeout(this.updatingMinDisplayTimerId);
    }
  },

  stopCurrentCheck() {
    this._appUpdater.removeListener(this._appUpdateListener);
    this._appUpdater.stop();
  },

  get update() {
    return this._appUpdater.update;
  },

  get selectedPanel() {
    return this.updateDeck.selectedPanel;
  },

  _onAppUpdateStatus(status, ...args) {
    switch (status) {
      case AppUpdater.STATUS.UPDATE_DISABLED_BY_POLICY:
        this.selectPanel("policyDisabled");
        break;
      case AppUpdater.STATUS.READY_FOR_RESTART:
        this.selectPanel("apply");
        break;
      case AppUpdater.STATUS.OTHER_INSTANCE_HANDLING_UPDATES:
        this.selectPanel("otherInstanceHandlingUpdates");
        break;
      case AppUpdater.STATUS.DOWNLOADING: {
        const downloadStatus = document.getElementById("downloadStatus");
        if (!args.length) {
          // Very early in the DOWNLOADING state, `selectedPatch` may not be
          // available yet. But this function will be called again when it is
          // available. A `maxSize < 0` indicates that the max size is not yet
          // available.
          let maxSize = -1;
          if (this.update.selectedPatch) {
            maxSize = this.update.selectedPatch.size;
          }
          downloadStatus.textContent = DownloadUtils.getTransferTotal(
            0,
            maxSize
          );
          this.selectPanel("downloading");
        } else {
          const [progress, max] = args;
          downloadStatus.textContent = DownloadUtils.getTransferTotal(
            progress,
            max
          );
        }
        break;
      }
      case AppUpdater.STATUS.STAGING:
        this.selectPanel("applying");
        break;
      case AppUpdater.STATUS.CHECKING: {
        this.checkingForUpdatesDelayPromise = new Promise(resolve => {
          this.updatingMinDisplayTimerId = setTimeout(
            resolve,
            UPDATING_MIN_DISPLAY_TIME_MS
          );
        });
        if (Services.policies.isAllowed("appUpdate")) {
          this.selectPanel("checkingForUpdates");
        } else {
          this.selectPanel("policyDisabled");
        }
        break;
      }
      case AppUpdater.STATUS.CHECKING_FAILED:
        this.selectPanel("checkingFailed");
        break;
      case AppUpdater.STATUS.NO_UPDATES_FOUND:
        this.checkingForUpdatesDelayPromise.then(() => {
          if (Services.policies.isAllowed("appUpdate")) {
            this.selectPanel("noUpdatesFound");
          } else {
            this.selectPanel("policyDisabled");
          }
        });
        break;
      case AppUpdater.STATUS.UNSUPPORTED_SYSTEM:
        if (this.update.detailsURL) {
          const unsupportedLink = document.getElementById("unsupportedLink");
          unsupportedLink.href = this.update.detailsURL;
        }
        this.selectPanel("unsupportedSystem");
        break;
      case AppUpdater.STATUS.MANUAL_UPDATE:
        this.selectPanel("manualUpdate");
        break;
      case AppUpdater.STATUS.DOWNLOAD_AND_INSTALL:
        this.selectPanel("downloadAndInstall");
        break;
      case AppUpdater.STATUS.DOWNLOAD_FAILED:
        this.selectPanel("downloadFailed");
        break;
      case AppUpdater.STATUS.INTERNAL_ERROR:
        this.selectPanel("internalError");
        break;
      case AppUpdater.STATUS.NEVER_CHECKED:
        this.selectPanel("checkForUpdates");
        break;
      case AppUpdater.STATUS.NO_UPDATER:
      default:
        this.selectPanel("noUpdater");
        document.getElementById("updateBox").style.maxHeight = "0";
        break;
    }
  },

  /**
   * Sets the panel of the updateDeck and the visibility of icons
   * in the #icons element.
   *
   * @param {string} aChildID - The id of the deck's child to select, e.g. "apply".
   */
  selectPanel(aChildID) {
    const panel = document.getElementById(aChildID);
    const icons = document.getElementById("icons");
    if (icons) {
      icons.className = aChildID;
    }

    // Make sure to select the panel before potentially auto-focusing the button.
    this.updateDeck.selectedPanel = panel;

    const button = panel.querySelector("button");
    if (button) {
      if (aChildID == "downloadAndInstall") {
        let updateVersion = gAppUpdater.update.displayVersion;
        // Include the build ID if this is an "a#" (nightly or aurora) build
        if (/a\d+$/.test(updateVersion)) {
          const buildID = gAppUpdater.update.buildID;
          const year = buildID.slice(0, 4);
          const month = buildID.slice(4, 6);
          const day = buildID.slice(6, 8);
          updateVersion += ` (${year}-${month}-${day})`;
        } else {
          const updateNotesLink = document.getElementById("updateNotes");
          if (updateNotesLink) {
            updateNotesLink.href = gAppUpdater.update.detailsURL;
            updateNotesLink.hidden = false;
          }
        }
        button.textContent = this.bundle.formatStringFromName(
          "update.downloadAndInstallButton.label",
          [updateVersion]
        );
        button.accessKey = this.bundle.GetStringFromName(
          "update.downloadAndInstallButton.accesskey"
        );
      }
      if (this.options.buttonAutoFocus) {
        let promise = Promise.resolve();
        if (document.readyState != "complete") {
          promise = new Promise(resolve =>
            window.addEventListener("load", resolve, { once: true })
          );
        }
        promise.then(() => {
          if (
            !document.commandDispatcher.focusedElement || // don't steal the focus
            // except from the other buttons
            document.commandDispatcher.focusedElement.localName == "button"
          ) {
            button.focus();
          }
        });
      }
    }
  },

  /**
   * Check for updates
   */
  checkForUpdates() {
    this._appUpdater.check();
  },

  /**
   * Handles oncommand for the "Restart to Update" button
   * which is presented after the download has been downloaded.
   */
  buttonRestartAfterDownload() {
    if (AUS.currentState != Ci.nsIApplicationUpdateService.STATE_PENDING) {
      return;
    }

    gAppUpdater.selectPanel("restarting");

    // Notify all windows that an application quit has been requested.
    const cancelQuit = Cc["@mozilla.org/supports-PRBool;1"].createInstance(
      Ci.nsISupportsPRBool
    );
    Services.obs.notifyObservers(
      cancelQuit,
      "quit-application-requested",
      "restart"
    );

    // Something aborted the quit process.
    if (cancelQuit.data) {
      gAppUpdater.selectPanel("apply");
      return;
    }

    // If already in safe mode restart in safe mode (bug 327119)
    if (Services.appinfo.inSafeMode) {
      Services.startup.restartInSafeMode(Ci.nsIAppStartup.eAttemptQuit);
      return;
    }

    if (
      !Services.startup.quit(
        Ci.nsIAppStartup.eAttemptQuit | Ci.nsIAppStartup.eRestart
      )
    ) {
      // Either the user or the hidden window aborted the quit process.
      gAppUpdater.selectPanel("apply");
    }
  },

  /**
   * Starts the download of an update mar.
   */
  startDownload() {
    this._appUpdater.allowUpdateDownload();
  },
};

window.addEventListener("load", () => {
  for (const link of document.querySelectorAll(".download-link")) {
    link.addEventListener("click", event => {
      event.preventDefault();
      openLinkExternally(event.target.href, { addToHistory: false });
    });
  }
});
