/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const Cm = Components.manager;
Cm.QueryInterface(Ci.nsIServiceManager);

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";
import { XPCOMUtils } from "resource://gre/modules/XPCOMUtils.sys.mjs";

const lazy = {};
XPCOMUtils.defineLazyPreferenceGetter(
  lazy,
  "BROWSER_STARTUP_RECORD",
  "browser.startup.record",
  false
);
XPCOMUtils.defineLazyPreferenceGetter(
  lazy,
  "BROWSER_STARTUP_RECORD_IMAGES",
  "browser.startup.recordImages",
  false
);

let firstPaintNotification = "widget-first-paint";
// widget-first-paint fires much later than expected on Linux.
if (AppConstants.platform == "linux") {
  firstPaintNotification = "xul-window-visible";
}

let win, canvas;
let paints = [];
const afterPaintListener = () => {
  let width, height;
  canvas.width = width = win.innerWidth;
  canvas.height = height = win.innerHeight;
  if (width < 1 || height < 1) {
    return;
  }
  const ctx = canvas.getContext("2d", {
    alpha: false,
    willReadFrequently: true,
  });

  ctx.drawWindow(
    win,
    0,
    0,
    width,
    height,
    "white",
    ctx.DRAWWINDOW_DO_NOT_FLUSH |
      ctx.DRAWWINDOW_DRAW_VIEW |
      ctx.DRAWWINDOW_ASYNC_DECODE_IMAGES |
      ctx.DRAWWINDOW_USE_WIDGET_LAYERS
  );
  paints.push({
    data: ctx.getImageData(0, 0, width, height).data,
    width,
    height,
  });
};

/**
 * The StartupRecorder component observes notifications at various stages of
 * startup and records the set of JS modules that were already loaded at
 * each of these points.
 * The records are meant to be used by startup tests in
 * browser/base/content/test/performance
 * This component only exists in nightly and debug builds, it doesn't ship in
 * our release builds.
 */
export function StartupRecorder() {
  this.wrappedJSObject = this;
  this.data = {
    images: {
      "image-drawing": new Set(),
      "image-loading": new Set(),
    },
    code: {},
    extras: {},
    prefStats: {},
  };
  this.done = new Promise(resolve => {
    this._resolve = resolve;
  });
}

StartupRecorder.prototype = {
  QueryInterface: ChromeUtils.generateQI(["nsIObserver"]),

  record(name) {
    ChromeUtils.addProfilerMarker("startupRecorder:" + name);
    this.data.code[name] = {
      modules: Cu.loadedESModules,
      services: Object.keys(Cc).filter(c => {
        try {
          return Cm.isServiceInstantiatedByContractID(c, Ci.nsISupports);
        } catch (e) {
          return false;
        }
      }),
    };
    this.data.extras[name] = {
      hiddenWindowLoaded: Services.appShell.hasHiddenWindow,
    };
  },

  observe(subject, topic, data) {
    if (topic == "app-startup" || topic == "content-process-ready-for-script") {
      // Don't do anything in xpcshell.
      if (Services.appinfo.ID != "{3550f703-e582-4d05-9a08-453d09bdfdc6}") {
        return;
      }

      if (!lazy.BROWSER_STARTUP_RECORD && !lazy.BROWSER_STARTUP_RECORD_IMAGES) {
        this._resolve();
        this._resolve = null;
        return;
      }

      // We can't ensure our observer will be called first or last, so the list of
      // topics we observe here should avoid the topics used to trigger things
      // during startup (eg. the topics observed by BrowserGlue.sys.mjs).
      let topics = [
        "profile-do-change", // This catches stuff loaded during app-startup
        "toplevel-window-ready", // Catches stuff from final-ui-startup
        firstPaintNotification,
        "mail-startup-done",
        "mail-startup-idle-tasks-finished",
      ];

      if (lazy.BROWSER_STARTUP_RECORD_IMAGES) {
        // For code simplicify, recording images excludes the other startup
        // recorder behaviors, so we can observe only the image topics.
        topics = [
          "image-loading",
          "image-drawing",
          "mail-startup-idle-tasks-finished",
        ];
      }
      for (const t of topics) {
        Services.obs.addObserver(this, t);
      }
      return;
    }

    // We only care about the first paint notification for browser windows, and
    // not other types (for example, the gfx sanity test window)
    if (topic == firstPaintNotification) {
      // In the case we're handling xul-window-visible, we'll have been handed
      // an nsIAppWindow instead of an nsIDOMWindow.
      if (subject instanceof Ci.nsIAppWindow) {
        subject = subject
          .QueryInterface(Ci.nsIInterfaceRequestor)
          .getInterface(Ci.nsIDOMWindow);
      }

      if (
        subject.document.documentElement.getAttribute("windowtype") !=
        "mail:3pane"
      ) {
        return;
      }
    }

    if (topic == "image-drawing" || topic == "image-loading") {
      this.data.images[topic].add(data);
      return;
    }

    Services.obs.removeObserver(this, topic);

    if (topic == firstPaintNotification) {
      // Because of the check for mail:3pane we made earlier, we know
      // that if we got here, then the subject must be the first browser window.
      win = subject;
      canvas = win.document.createElementNS(
        "http://www.w3.org/1999/xhtml",
        "canvas"
      );
      canvas.mozOpaque = true;
      afterPaintListener();
      win.addEventListener("MozAfterPaint", afterPaintListener);
    }

    // TODO: Figure out what can replace this section.
    if (topic == "mail-startup-done") {
      // We use idleDispatchToMainThread here to record the set of
      // loaded scripts after we are fully done with startup and ready
      // to react to user events.
      Services.tm.dispatchToMainThread(
        this.record.bind(this, "before handling user events")
      );
    } else if (topic == "mail-startup-idle-tasks-finished") {
      if (lazy.BROWSER_STARTUP_RECORD_IMAGES) {
        Services.obs.removeObserver(this, "image-drawing");
        Services.obs.removeObserver(this, "image-loading");
        this._resolve();
        this._resolve = null;
        return;
      }

      this.record("before becoming idle");
      win.removeEventListener("MozAfterPaint", afterPaintListener);
      win = null;
      this.data.frames = paints;
      this.data.prefStats = {};
      if (AppConstants.DEBUG) {
        Services.prefs.readStats(
          (key, value) => (this.data.prefStats[key] = value)
        );
      }
      paints = null;

      if (!Services.env.exists("MOZ_PROFILER_STARTUP_PERFORMANCE_TEST")) {
        this._resolve();
        this._resolve = null;
        return;
      }

      Services.profiler.getProfileDataAsync().then(profileData => {
        this.data.profile = profileData;
        // There's no equivalent StartProfiler call in this file because the
        // profiler is started using the MOZ_PROFILER_STARTUP environment
        // variable in browser/base/content/test/performance/browser.ini
        Services.profiler.StopProfiler();

        this._resolve();
        this._resolve = null;
      });
    } else {
      const topicsToNames = {
        "profile-do-change": "before profile selection",
        "toplevel-window-ready": "before opening first browser window",
      };
      topicsToNames[firstPaintNotification] = "before first paint";
      this.record(topicsToNames[topic]);
    }
  },
};
