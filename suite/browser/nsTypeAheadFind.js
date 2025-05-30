/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const kSpace = " ".charCodeAt(0);
const kSlash = "/".charCodeAt(0);
const kApostrophe = "'".charCodeAt(0);

var {XPCOMUtils} = ChromeUtils.import("resource://gre/modules/XPCOMUtils.jsm");

function findTypeController(aTypeAheadFind, aWindow)
{
  this.mTypeAheadFind = aTypeAheadFind;
  this.mWindow = aWindow;
}

findTypeController.prototype = {
  /* nsIController */
  supportsCommand: function(aCommand) {
    return aCommand == "cmd_findTypeText" || aCommand == "cmd_findTypeLinks";
  },

  isCommandEnabled: function(aCommand) {
    // We can always find if there's a primary content window in which to find.
    if (this.mWindow.content)
      return true;

    // We can also find if the focused window is a content window.
    // Note: this gets called during a focus change
    // so the new window might not have focus yet.
    var commandDispatcher = this.mWindow.document.commandDispatcher;
    var e = commandDispatcher.focusedElement;
    var w = e ? e.ownerDocument.defaultView : commandDispatcher.focusedWindow;
    return w.top != this.mWindow;
  },

  doCommand: function(aCommand) {
    this.mTypeAheadFind.startFind(this.mWindow, aCommand != "cmd_findTypeText");
  },

  onEvent: function(aEvent) {
  }
}

function typeAheadFind()
{
}

typeAheadFind.prototype = {
  /* properties required for XPCOMUtils */
  classID: Components.ID("{45c8f75b-a299-4178-a461-f63690389055}"),

  /* members */
  mBadKeysSinceMatch: 0,
  mBundle: null,
  mCurrentWindow: null,
  mEventTarget: null,
  mFind: null,
  mFindService: null,
  mFound: null,
  mLinks: false,
  mSearchString: "",
  mSelection: null,
  mTimer: null,
  mXULBrowserWindow: null,

  /* nsISupports */
  QueryInterface: ChromeUtils.generateQI([
      Ci.nsISupportsWeakReference,
      Ci.nsIObserver,
      Ci.nsITimerCallback,
      Ci.nsISelectionListener]),

  /* nsIObserver */
  observe: function(aSubject, aTopic, aData) {
    if (aTopic == "app-startup") {
      // It's now safe to get our pref branch.
      this.mPrefs = Services.prefs.getBranch("accessibility.typeaheadfind.");
      // We need to add our event listeners to all windows.
      Services.ww.registerNotification(this);
      // We also need to listen for find again commands
      Services.obs.addObserver(this, "nsWebBrowserFind_FindAgain", true);
    }
    if (aTopic == "domwindowopened") {
      // Add our listeners. They get automatically removed on window teardown.
      aSubject.controllers.appendController(new findTypeController(this, aSubject));
      Services.els.addSystemEventListener(aSubject, "keypress", this, false);
    }
    if (aTopic == "nsWebBrowserFind_FindAgain" &&
        aSubject instanceof Ci.nsISupportsInterfacePointer &&
        aSubject.data instanceof Ci.nsIDOMWindow &&
        aSubject.data.top == this.mCurrentWindow &&
        this.mSearchString) {
      // It's a find again. Was it one that we just searched for?
      var w = aSubject.data;
      var find = w.QueryInterface(Ci.nsIInterfaceRequestor)
                  .getInterface(Ci.nsIWebNavigation)
                  .QueryInterface(Ci.nsIInterfaceRequestor)
                  .getInterface(Ci.nsIWebBrowserFind);
      if (find.searchString.toLowerCase() == this.mSearchString) {
        var reverse = aData == "up";
        this.stopFind(false);
        var result = Ci.nsITypeAheadFind.FIND_NOTFOUND;
        if (!this.mBadKeysSinceMatch)
          result = this.mFind.findAgain(reverse, this.mLinks);
        this.showStatusMatch(result, reverse ? "prevmatch" : "nextmatch");
        // Don't let anyone else try to find again.
        aSubject.data = null;
      }
    }
  },

  /* nsITimerCallback */
  notify: function(aTimer) {
    this.stopFind(false);
  },

  /* EventListener */
  handleEvent: function(aEvent) {
    if (!aEvent.type.startsWith("key")) {
      this.stopFind(false);
      return true;
    }

    // We don't care about these keys.
    if (aEvent.altKey || aEvent.ctrlKey || aEvent.metaKey)
      return true;

    if (aEvent.type != "keypress") {
      aEvent.stopPropagation();
      return true;
    }

    // Are we already in a find?
    if (aEvent.eventPhase == Ci.nsIDOMEvent.CAPTURING_PHASE)
      return this.processKey(aEvent);

    // Check whether we want to start a new find.
    if (aEvent.defaultPrevented)
      return true;

    // We don't want to start a find on a control character.
    // We also don't want to start on a space, since that scrolls the page.
    if (aEvent.keyCode || aEvent.charCode <= kSpace)
      return true;

    // Don't start a find if the focus is an editable element.
    var window = aEvent.currentTarget;
    var element = window.document.commandDispatcher.focusedElement;
    if (element.nodeType == element.ELEMENT_NODE &&
        element.namespaceURI == "http://www.w3.org/1999/xhtml" &&
        element.isContentEditable)
      return true;

    // Don't start a find if the focus is on a form element.
    if ((element.nodeType == element.ELEMENT_NODE &&
         element.namespaceURI == "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul") ||
        ChromeUtils.getClassName(element) === "HTMLEmbedElement" ||
        ChromeUtils.getClassName(element) === "HTMLObjectElement" ||
        ChromeUtils.getClassName(element) === "HTMLSelectElement" ||
        ChromeUtils.getClassName(element) === "HTMLTextAreaElement")
      return true;

    // Don't start a find if the focus is on an editable field
    if (ChromeUtils.getClassName(element) === "HTMLInputElement" &&
        element.mozIsTextField(false))
      return true;

    // Don't start a find if the focus isn't or can't be set to content
    var w = window.document.commandDispatcher.focusedWindow;
    if (w.top == window)
      w = window.content;
    if (!w)
      return true;

    var webNav = w.QueryInterface(Ci.nsIInterfaceRequestor)
                  .getInterface(Ci.nsIWebNavigation);
    try {
      // Don't start a find if the window is in design mode
      if (webNav.QueryInterface(Ci.nsIInterfaceRequestor)
                .getInterface(Ci.nsIEditingSession)
                .windowIsEditable(w))
        return true;
    } catch (e) {
    }

    switch (aEvent.charCode) {
      // Start finding text as you type
      case kSlash:
        aEvent.preventDefault();
        this.startFind(window, false);
        break;

      // Start finding links as you type
      case kApostrophe:
        aEvent.preventDefault();
        this.startFind(window, true);
        break;

      default:
        // Don't start if typeahead find is disabled
        if (!this.mPrefs.getBoolPref("autostart"))
          return true;
        // Don't start in windows that don't want autostart
        if (webNav.QueryInterface(Ci.nsIDocShell)
                  .chromeEventHandler.getAttribute("autofind") == "false")
          return true;
        this.startFind(window, this.mPrefs.getBoolPref("linksonly"));
        this.processKey(aEvent);
    }
    return false;
  },

  /* nsISelectionListener */
  notifySelectionChanged: function(aDoc, aSelection, aReason) {
    this.stopFind(false);
  },

  /* private methods */
  showStatus: function(aText) {
    if (this.mXULBrowserWindow)
      this.mXULBrowserWindow.setOverLink(aText, null);
  },
  showStatusString: function(aString) {
    // Set the status text from a localised string
    this.showStatus(aString && this.mBundle.GetStringFromName(aString));
  },
  showStatusMatch: function(aResult, aExtra) {
    // Set the status text from a find result
    // link|text "..." [not] found [next|previous match] [(href)]
    if (aExtra)
      aExtra = " " + this.mBundle.GetStringFromName(aExtra);
    var url = "";
    var string = this.mLinks ? "link" : "text";
    if (aResult == Ci.nsITypeAheadFind.FIND_NOTFOUND)
      string += "not";
    else if (this.mFind.foundLink && this.mFind.foundLink.href)
      url = "  " + this.mBundle.GetStringFromName("openparen") +
                   this.mFind.foundLink.href +
                   this.mBundle.GetStringFromName("closeparen");
    string += "found";
    this.showStatus(this.mBundle.GetStringFromName(string) +
                    this.mSearchString +
                    this.mBundle.GetStringFromName("closequote") +
                    aExtra + url);
  },
  startTimer: function() {
    if (this.mPrefs.getBoolPref("enabletimeout")) {
      if (!this.mTimer)
        this.mTimer = Cc["@mozilla.org/timer;1"]
                        .createInstance(Ci.nsITimer);
      this.mTimer.initWithCallback(this,
          this.mPrefs.getIntPref("timeout"),
          Ci.nsITimer.TYPE_ONE_SHOT);
    }
  },
  processKey: function(aEvent) {
    // Escape always cancels the find.
    if (aEvent.keyCode == aEvent.DOM_VK_ESCAPE) {
      aEvent.preventDefault();
      aEvent.stopPropagation();
      this.stopFind(false);
      return false;
    }

    var result = Ci.nsITypeAheadFind.FIND_NOTFOUND;
    if (aEvent.keyCode == aEvent.DOM_VK_BACK_SPACE) {
      aEvent.preventDefault();
      aEvent.stopPropagation();
      this.mSearchString = this.mSearchString.slice(0, -1);
      // Backspacing past the start of the string cancels the find.
      if (!this.mSearchString) {
        this.stopFind(true);
        return false;
      }
      this.startTimer();
      // The find will change the selection, so stop listening for changes
      this.mEventTarget.removeEventListener("blur", this, true);
      if (this.mSelection)
        this.mSelection.removeSelectionListener(this);
      // Don't bother finding until we get back to a working string
      if (!this.mBadKeysSinceMatch || !--this.mBadKeysSinceMatch)
        result = this.mFind.find(this.mSearchString, this.mLinks);
    } else {
      // Ignore control characters.
      if (aEvent.keyCode || aEvent.charCode < kSpace)
        return true;

      this.startTimer();
      aEvent.preventDefault();
      aEvent.stopPropagation();

      // It looks as if the cat walked on the keyboard.
      if (this.mBadKeysSinceMatch >= 3)
        return false;

      // The find will change the selection/focus, so stop listening for changes
      this.mEventTarget.removeEventListener("blur", this, true);
      if (this.mSelection)
        this.mSelection.removeSelectionListener(this);
      var previousString = this.mSearchString;
      this.mSearchString += String.fromCharCode(aEvent.charCode).toLowerCase();
      if (!this.mBadKeysSinceMatch) {
        result = this.mFind.find(this.mSearchString, this.mLinks);
        if (previousString &&
            result == Ci.nsITypeAheadFind.FIND_NOTFOUND)
          // Use a separate find instance to rehighlight the previous match
          // until bug 463294 is fixed.
          this.mFound.find(previousString, this.mLinks);
      }
      if (result == Ci.nsITypeAheadFind.FIND_NOTFOUND)
        this.mBadKeysSinceMatch++;
    }

    // Ensure that the correct frame is focused (work around for bug 485213).
    if (this.mFind.currentWindow)
      this.mFind.currentWindow.focus();

    this.showStatusMatch(result, "");
    if (!this.mFindService)
      this.mFindService = Cc["@mozilla.org/find/find_service;1"]
                            .getService(Ci.nsIFindService);
    this.mFindService.searchString = this.mSearchString;
    // Watch for blur changes in case the cursor leaves the current field.
    this.mEventTarget.addEventListener("blur", this, true);
    // Also watch for the cursor moving within the current field or window.
    var commandDispatcher = this.mEventTarget.ownerDocument.commandDispatcher;
    var editable = commandDispatcher.focusedElement;
    if (editable &&
        ["HTMLInputElement", "HTMLTextAreaElement"]
        .includes(ChromeUtils.getClassName(editable)))
      this.mSelection = editable.editor.selection;
    else
      this.mSelection = commandDispatcher.focusedWindow.getSelection();
    this.mSelection.addSelectionListener(this);
    return false;
  },
  startFind: function(aWindow, aLinks) {
    if (this.mEventTarget)
      this.stopFind(true);
    // Try to get the status bar for the specified window
    this.mXULBrowserWindow =
        aWindow.QueryInterface(Ci.nsIInterfaceRequestor)
               .getInterface(Ci.nsIWebNavigation)
               .QueryInterface(Ci.nsIDocShellTreeItem)
               .treeOwner
               .QueryInterface(Ci.nsIInterfaceRequestor)
               .getInterface(Ci.nsIXULWindow)
               .XULBrowserWindow;

    // If the current window is chrome then focus content instead
    var w = aWindow.document.commandDispatcher.focusedWindow.top;
    if (w == aWindow)
      (w = aWindow.content).focus();

    // Get two toolkit typeaheadfind instances if we don't have them already.
    var docShell = w.QueryInterface(Ci.nsIInterfaceRequestor)
                    .getInterface(Ci.nsIWebNavigation)
                    .QueryInterface(Ci.nsIDocShell);
    if (!this.mFind) {
      this.mFind = Cc["@mozilla.org/typeaheadfind;1"]
                     .createInstance(Ci.nsITypeAheadFind);
      this.mFind.init(docShell);
      this.mFound = Cc["@mozilla.org/typeaheadfind;1"]
                             .createInstance(Ci.nsITypeAheadFind);
      this.mFound.init(docShell);
    }

    // Get the string bundle if we don't have it already.
    if (!this.mBundle)
      this.mBundle = Services.strings
                       .createBundle("chrome://communicator/locale/typeaheadfind.properties");

    // Set up all our properties
    this.mFind.setDocShell(docShell);
    this.mFound.setDocShell(docShell);
    this.mEventTarget = docShell.chromeEventHandler;
    this.mEventTarget.addEventListener("keypress", this, true);
    this.mEventTarget.addEventListener("keydown", this, true);
    this.mEventTarget.addEventListener("keyup", this, true);
    this.mEventTarget.addEventListener("pagehide", this, true);
    this.mCurrentWindow = w;
    this.mBadKeysSinceMatch = 0;
    this.mSearchString = "";
    this.mLinks = aLinks;
    this.showStatusString(this.mLinks ? "startlinkfind" : "starttextfind");
    this.startTimer();
  },
  stopFind: function(aClear) {
    if (this.mTimer)
      this.mTimer.cancel();
    if (this.mFind)
      this.mFind.setSelectionModeAndRepaint(
          Ci.nsISelectionController.SELECTION_ON);
    if (this.mEventTarget) {
      this.mEventTarget.removeEventListener("blur", this, true);
      this.mEventTarget.removeEventListener("pagehide", this, true);
      this.mEventTarget.removeEventListener("keypress", this, true);
      this.mEventTarget.removeEventListener("keydown", this, true);
      this.mEventTarget.removeEventListener("keyup", this, true);
    }
    this.mEventTarget = null;
    if (this.mSelection)
      this.mSelection.removeSelectionListener(this);
    this.mSelection = null;
    this.showStatusString(aClear ? "" : "stopfind");
    if (aClear)
      this.mSearchString = "";
    if (aClear && this.mFind)
      this.mFind.collapseSelection();
  },
};

var NSGetFactory = XPCOMUtils.generateNSGetFactory([typeAheadFind]);
