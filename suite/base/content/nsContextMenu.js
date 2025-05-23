/* -*- Mode: C; tab-width: 4; indent-tabs-mode: nil; c-basic-offset: 4 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/*------------------------------ nsContextMenu ---------------------------------
|   This JavaScript "class" is used to implement the browser's content-area    |
|   context menu.                                                              |
|                                                                              |
|   For usage, see references to this class in navigator.xul.                  |
|                                                                              |
|   Currently, this code is relatively useless for any other purpose.  In the  |
|   longer term, this code will be restructured to make it more reusable.      |
------------------------------------------------------------------------------*/

var {BrowserUtils} =
  ChromeUtils.import("resource://gre/modules/BrowserUtils.jsm");
var {XPCOMUtils} = ChromeUtils.import("resource://gre/modules/XPCOMUtils.jsm");
var {LoginManagerContextMenu} =
  ChromeUtils.import("resource://gre/modules/LoginManagerContextMenu.jsm");

XPCOMUtils.defineLazyGetter(this, "InlineSpellCheckerUI", () => {
  let { InlineSpellChecker } = ChromeUtils.import(
    "resource://gre/modules/InlineSpellChecker.jsm"
  );
  return new InlineSpellChecker();
});

XPCOMUtils.defineLazyGetter(this, "PageMenuParent", function() {
  let tmp = {};
  ChromeUtils.import("resource://gre/modules/PageMenu.jsm", tmp);
  return new tmp.PageMenuParent();
});

XPCOMUtils.defineLazyModuleGetters(this, {
  SpellCheckHelper: "resource://gre/modules/InlineSpellChecker.jsm",
  findCssSelector: "resource://gre/modules/css-selector.js",
  LoginHelper: "resource://gre/modules/LoginHelper.jsm",
  LoginManagerContent: "resource://gre/modules/LoginManagerContent.jsm",
  DevToolsShim: "chrome://devtools-startup/content/DevToolsShim.jsm",
  NetUtil: "resource://gre/modules/NetUtil.jsm",
  ShellService: "resource:///modules/ShellService.jsm",

});

var gContextMenuContentData = null;

function nsContextMenu(aXulMenu, aIsShift, aEvent) {
  this.shouldDisplay = true;
  this.initMenu(aXulMenu, aIsShift, aEvent);
}

// Prototype for nsContextMenu "class."
nsContextMenu.prototype = {
  initMenu: function(aXulMenu, aIsShift, aEvent) {
    // Get contextual info.
    this.setTarget(document.popupNode, document.popupRangeParent,
                   document.popupRangeOffset);

    if (!this.shouldDisplay)
      return;

    this.hasPageMenu = false;
    if (!aIsShift && this.browser.docShell.allowJavascript &&
        Services.prefs.getBoolPref("javascript.enabled"))
      this.hasPageMenu = PageMenuParent.buildAndAddToPopup(this.target, aXulMenu);

    this.isTextSelected = this.isTextSelection();
    this.isContentSelected = this.isContentSelection();

    // Initialize gContextMenuContentData.
    if (aEvent)
      this.initContentData(aEvent);
    // Initialize (disable/remove) menu items.
    this.initItems();
  },

  initContentData: function(aEvent) {
    var addonInfo = {};
    var subject = {
      event: aEvent,
      addonInfo: addonInfo,
    };
    subject.wrappedJSObject = subject;
    // Notifies the Addon-SDK which then populates addonInfo.
    Services.obs.notifyObservers(subject, "content-contextmenu");

    var popupNode = this.target;
    var doc = popupNode.ownerDocument;

    var contentType = null;
    var contentDisposition = null;
    if (this.onImage) {
      try {
        let imageCache = Cc["@mozilla.org/image/tools;1"]
                           .getService(Ci.imgITools)
                           .getImgCacheForDocument(doc);
        let props = imageCache.findEntryProperties(popupNode.currentURI, doc);
        if (props) {
          let nsISupportsCString = Ci.nsISupportsCString;
          contentType = props.get("type", nsISupportsCString).data;
          try {
            contentDisposition = props.get("content-disposition",
                                           nsISupportsCString).data;
          } catch (e) {}
        }
      } catch (e) {
        Cu.reportError(e);
      }
    }

    gContextMenuContentData = {
      isRemote: false,
      event: aEvent,
      popupNode: popupNode,
      browser: this.browser,
      principal: doc.nodePrincipal,
      addonInfo: addonInfo,
      documentURIObject: doc.documentURIObject,
      docLocation: doc.location.href,
      charSet: doc.characterSet,
      referrer: doc.referrer,
      referrerPolicy: doc.referrerPolicy,
      contentType: contentType,
      contentDisposition: contentDisposition,
      frameOuterWindowID: doc.defaultView.QueryInterface(Ci.nsIInterfaceRequestor)
                                         .getInterface(Ci.nsIDOMWindowUtils)
                                         .outerWindowID,
      loginFillInfo: LoginManagerContent.getFieldContext(popupNode),
    };
  },

  hiding: function () {
    gContextMenuContentData = null;
    InlineSpellCheckerUI.clearSuggestionsFromMenu();
    InlineSpellCheckerUI.clearDictionaryListFromMenu();
    InlineSpellCheckerUI.uninit();
    LoginManagerContextMenu.clearLoginsFromMenu(document);
  },

  initItems: function() {
    this.initPageMenuSeparator();
    this.initOpenItems();
    this.initNavigationItems();
    this.initViewItems();
    this.initMiscItems();
    this.initSpellingItems();
    this.initSaveItems();
    this.initClipboardItems();
    this.initMetadataItems();
    this.initMediaPlayerItems();
    this.initPasswordManagerItems();
  },

  initPageMenuSeparator: function() {
    this.showItem("page-menu-separator", this.hasPageMenu);
  },

  initOpenItems: function() {
    var showOpen = this.onSaveableLink || (this.inDirList && this.onLink);
    this.showItem("context-openlinkintab", showOpen);
    this.showItem("context-openlink", showOpen && !gPrivate);
    this.showItem("context-openlinkinprivatewindow", showOpen);
    this.showItem("context-sep-open", showOpen);
  },

  initNavigationItems: function() {
    // Back/Forward determined by canGoBack/canGoForward broadcasters.
    this.setItemAttrFromNode("context-back", "disabled", "canGoBack");
    this.setItemAttrFromNode("context-forward", "disabled", "canGoForward");

    var showNav = !(this.isContentSelected || this.onLink || this.onImage ||
                    this.onCanvas || this.onVideo || this.onAudio ||
                    this.onTextInput);

    this.showItem("context-back", showNav);
    this.showItem("context-forward", showNav);
    this.showItem("context-reload", showNav);
    this.showItem("context-stop", showNav);
    this.showItem("context-sep-stop", showNav);

    // XXX: Stop is determined in navigator.js; the canStop broadcaster is broken
    //this.setItemAttrFromNode( "context-stop", "disabled", "canStop" );
  },

  initSaveItems: function() {
    var showSave = !(this.inDirList || this.isContentSelected ||
                     this.onTextInput || this.onStandaloneImage ||
                     this.onCanvas || this.onVideo || this.onAudio ||
                     (this.onLink && this.onImage));
    if (showSave)
      goSetMenuValue("context-savepage",
                     this.autoDownload ? "valueSave" : "valueSaveAs");
    this.showItem("context-savepage", showSave);

    // Save/send link depends on whether we're in a link.
    if (this.onSaveableLink)
      goSetMenuValue("context-savelink",
                     this.autoDownload ? "valueSave" : "valueSaveAs");
    this.showItem("context-savelink", this.onSaveableLink);
    this.showItem("context-sendlink", this.onSaveableLink);

    // Save image depends on having loaded its content, video and audio don't.
    showSave = (this.onLoadedImage && this.onCompletedImage) ||
               this.onStandaloneImage || this.onCanvas;
    if (showSave)
      goSetMenuValue("context-saveimage",
                     this.autoDownload ? "valueSave" : "valueSaveAs");
    this.showItem("context-saveimage", showSave);
    this.showItem("context-savevideo", this.onVideo);
    this.showItem("context-saveaudio", this.onAudio);
    this.showItem("context-video-saveimage", this.onVideo);
    if (this.onVideo)
      this.setItemAttr("context-savevideo", "disabled", !this.mediaURL);
    if (this.onAudio)
      this.setItemAttr("context-saveaudio", "disabled", !this.mediaURL);

    // Send media URL (but not for canvas, since it's a big data: URL)
    this.showItem("context-sendimage", showSave && !this.onCanvas);
    this.showItem("context-sendvideo", this.onVideo);
    this.showItem("context-sendaudio", this.onAudio);
    if (this.onVideo)
      this.setItemAttr("context-sendvideo", "disabled", !this.mediaURL);
    if (this.onAudio)
      this.setItemAttr("context-sendaudio", "disabled", !this.mediaURL);
  },

  initViewItems: function() {
    // View source is always OK, unless in directory listing.
    this.showItem("context-viewpartialsource-selection",
                  this.isContentSelected && !this.onTextInput);
    this.showItem("context-viewpartialsource-mathml",
                  this.onMathML && !this.isContentSelected);

    var showView = !(this.inDirList || this.onImage || this.isContentSelected ||
                     this.onCanvas || this.onVideo || this.onAudio ||
                     this.onLink || this.onTextInput);

    this.showItem("context-viewsource", showView);
    this.showItem("context-viewinfo", showView);

    var showInspect = DevToolsShim.isEnabled() &&
                      "gDevTools" in window &&
                      Services.prefs.getBoolPref("devtools.inspector.enabled", false);
    this.showItem("inspect-separator", showInspect);
    this.showItem("context-inspect", showInspect);

    this.showItem("context-sep-properties",
                  !(this.inDirList || this.isContentSelected || this.onTextInput ||
                    this.onCanvas || this.onVideo || this.onAudio));
    // Set Desktop Background depends on whether an image was clicked on,
    // and requires the shell service.
    var canSetDesktopBackground = ShellService &&
                                  ShellService.canSetDesktopBackground;
    this.showItem("context-setDesktopBackground",
                  canSetDesktopBackground && (this.onLoadedImage || this.onStandaloneImage));

    this.showItem("context-sep-image",
                  this.onLoadedImage || this.onStandaloneImage);

    if (canSetDesktopBackground && this.onLoadedImage)
      // Disable the Set Desktop Background menu item if we're still trying to load the image
      this.setItemAttr("context-setDesktopBackground", "disabled",
                       (("complete" in this.target) && !this.target.complete) ? "true" : null);

    this.showItem("context-fitimage", this.onStandaloneImage &&
                                      content.document.imageResizingEnabled);
    if (this.onStandaloneImage && content.document.imageResizingEnabled) {
      this.setItemAttr("context-fitimage", "disabled",
                       content.document.imageIsOverflowing ? null : "true");
      this.setItemAttr("context-fitimage", "checked",
                       content.document.imageIsResized ? "true" : null);
    }

    // Reload image depends on an image that's not fully loaded
    this.showItem("context-reloadimage", (this.onImage && !this.onCompletedImage));

    // View image depends on having an image that's not standalone
    // (or is in a frame), or a canvas.
    this.showItem("context-viewimage",
                  (this.onImage && (!this.inSyntheticDoc || this.inFrame)) ||
                  this.onCanvas);

    // View video depends on not having a standalone video.
    this.showItem("context-viewvideo", this.onVideo &&
                                       (!this.inSyntheticDoc || this.inFrame));
    this.setItemAttr("context-viewvideo", "disabled", !this.mediaURL);

    // View background image depends on whether there is one, but don't make
    // background images of a stand-alone media document available
    this.showItem("context-viewbgimage", showView && !this.inSyntheticDoc);
    this.showItem("context-sep-viewbgimage", showView && !this.inSyntheticDoc);
    this.setItemAttr("context-viewbgimage", "disabled", this.hasBGImage ? null : "true");

    this.showItem("context-viewimageinfo", this.onImage);

    // Hide Block and Unblock menuitems.
    this.showItem("context-blockimage", false);
    this.showItem("context-unblockimage", false);
    this.showItem("context-sep-blockimage", false);

    // Block image depends on whether an image was clicked on.
    if (this.onImage) {
      var uri = Services.io.newURI(this.mediaURL);
      if (uri instanceof Ci.nsIURL && uri.host) {
        var serverLabel = uri.host;
        // Limit length to max 15 characters.
        serverLabel = serverLabel.replace(/^www\./i, "");
        if (serverLabel.length > 15)
          serverLabel = serverLabel.substr(0, 15) + this.ellipsis;

        // Set label and accesskey for appropriate action and unhide menuitem.
        var id = "context-blockimage";
        var attr = "blockImage";
        if (Services.perms.testPermission(uri, "image") == Services.perms.DENY_ACTION) {
          id = "context-unblockimage";
          attr = "unblockImage";
        }
        const bundle = document.getElementById("contentAreaCommandsBundle");
        this.setItemAttr(id, "label",
                         bundle.getFormattedString(attr, [serverLabel]));
        this.setItemAttr(id, "accesskey",
                         bundle.getString(attr + ".accesskey"));
        this.showItem(id, true);
        this.showItem("context-sep-blockimage", true);
      }
    }
  },

  initMiscItems: function() {
    // Use "Bookmark This Link" if on a link.
    this.showItem("context-bookmarkpage",
                  !(this.isContentSelected || this.onTextInput ||
                    this.onStandaloneImage || this.onVideo || this.onAudio));
    this.showItem("context-bookmarklink", this.onLink && !this.onMailtoLink);
    this.showItem("context-searchselect", this.isTextSelected);
    this.showItem("context-keywordfield", this.onTextInput && this.onKeywordField);
    this.showItem("frame", this.inFrame);
    this.showItem("frame-sep", this.inFrame);
    if (this.inFrame)
      goSetMenuValue("context-saveframe",
                     this.autoDownload ? "valueSave" : "valueSaveAs");

    // BiDi UI
    this.showItem("context-sep-bidi", !this.onNumeric && gShowBiDi);
    this.showItem("context-bidi-text-direction-toggle",
                  this.onTextInput && !this.onNumeric && gShowBiDi);
    this.showItem("context-bidi-page-direction-toggle",
                  !this.onTextInput && gShowBiDi);
  },

  initSpellingItems: function() {
    var canSpell = InlineSpellCheckerUI.canSpellCheck &&
                   !InlineSpellCheckerUI.initialSpellCheckPending &&
                   this.canSpellCheck;
    let showDictionaries = canSpell && InlineSpellCheckerUI.enabled;
    var onMisspelling = InlineSpellCheckerUI.overMisspelling;
    var showUndo = canSpell && InlineSpellCheckerUI.canUndo();
    this.showItem("spell-check-enabled", canSpell);
    this.showItem("spell-separator", canSpell);
    if (canSpell)
      this.setItemAttr("spell-check-enabled", "checked", InlineSpellCheckerUI.enabled);
    this.showItem("spell-add-to-dictionary", onMisspelling);
    this.showItem("spell-undo-add-to-dictionary", showUndo);
    this.showItem("spell-ignore-word", onMisspelling);

    // suggestion list
    this.showItem("spell-add-separator", onMisspelling);
    this.showItem("spell-suggestions-separator", onMisspelling || showUndo);
    if (onMisspelling) {
      var suggestionsSeparator = document.getElementById("spell-add-separator");
      var numsug = InlineSpellCheckerUI.addSuggestionsToMenu(suggestionsSeparator.parentNode, suggestionsSeparator, 5);
      this.showItem("spell-no-suggestions", numsug == 0);
    } else {
      this.showItem("spell-no-suggestions", false);
    }

    // dictionary list
    this.showItem("spell-dictionaries", showDictionaries);
    var dictMenu = document.getElementById("spell-dictionaries-menu");
    if (canSpell && dictMenu) {
      var dictSep = document.getElementById("spell-language-separator");
      let count = InlineSpellCheckerUI.addDictionaryListToMenu(dictMenu, dictSep);
      this.showItem(dictSep, count > 0);
      this.showItem("spell-add-dictionaries-main", false);
    }
    else if (this.onEditableArea) {
      // when there is no spellchecker but we might be able to spellcheck
      // add the add to dictionaries item. This will ensure that people
      // with no dictionaries will be able to download them
      this.showItem("spell-language-separator", showDictionaries);
      this.showItem("spell-add-dictionaries-main", showDictionaries);
    }
    else
      this.showItem("spell-add-dictionaries-main", false);
  },

  initClipboardItems: function() {
    // Copy depends on whether there is selected text.
    // Enabling this context menu item is now done through the global
    // command updating system
    // this.setItemAttr("context-copy", "disabled", !this.isTextSelected());

    goUpdateGlobalEditMenuItems();

    this.showItem("context-undo", this.onTextInput);
    this.showItem("context-redo", this.onTextInput);
    this.showItem("context-sep-undo", this.onTextInput);
    this.showItem("context-cut", this.onTextInput);
    this.showItem("context-copy", this.isContentSelected || this.onTextInput);
    this.showItem("context-paste", this.onTextInput);
    this.showItem("context-delete", this.onTextInput);
    this.showItem("context-sep-paste", this.onTextInput);
    this.showItem("context-selectall", !(this.onLink || this.onImage ||
                                         this.onVideo || this.onAudio ||
                                         this.inSyntheticDoc));
    this.showItem("context-sep-selectall",
                  this.isContentSelected && !this.onTextInput);
    // In a text area there will be nothing after select all, so we don't want a sep
    // Otherwise, if there's text selected then there are extra menu items
    // (search for selection and view selection source), so we do want a sep

    // XXX dr
    // ------
    // nsDocumentViewer.cpp has code to determine whether we're
    // on a link or an image. we really ought to be using that...

    // Copy email link depends on whether we're on an email link.
    this.showItem("context-copyemail", this.onMailtoLink);

    // Copy link location depends on whether we're on a link.
    this.showItem("context-copylink", this.onLink);
    this.showItem("context-sep-copylink", this.onLink);

    // Copy image location depends on whether we're on an image.
    this.showItem("context-copyimage", this.onImage);
    this.showItem("context-copyvideourl", this.onVideo);
    this.showItem("context-copyaudiourl", this.onAudio);
    if (this.onVideo)
      this.setItemAttr("context-copyvideourl", "disabled", !this.mediaURL);
    if (this.onAudio)
      this.setItemAttr("context-copyaudiourl", "disabled", !this.mediaURL);
    this.showItem("context-sep-copyimage",
                  this.onImage || this.onVideo || this.onAudio);
  },

  initMetadataItems: function() {
    // Show if user clicked on something which has metadata.
    this.showItem("context-metadata", this.onMetaDataItem);
  },

  initMediaPlayerItems: function() {
    var onMedia = (this.onVideo || this.onAudio);
    // Several mutually exclusive items... play/pause, mute/unmute, show/hide
    this.showItem("context-media-play",
                  onMedia && (this.target.paused || this.target.ended));
    this.showItem("context-media-pause",
                  onMedia && !this.target.paused && !this.target.ended);
    this.showItem("context-media-mute", onMedia && !this.target.muted);
    this.showItem("context-media-unmute", onMedia && this.target.muted);
    this.showItem("context-media-playbackrate",
                  onMedia && this.target.duration != Number.POSITIVE_INFINITY);
    this.showItem("context-media-loop", onMedia);
    this.showItem("context-media-showcontrols", onMedia && !this.target.controls);
    this.showItem("context-media-hidecontrols", onMedia && this.target.controls);
    this.showItem("context-video-fullscreen", this.onVideo &&
                  !this.target.ownerDocument.fullscreenElement);

    var statsShowing = this.onVideo && this.target.mozMediaStatisticsShowing;
    this.showItem("context-video-showstats",
                  this.onVideo && this.target.controls && !statsShowing);
    this.showItem("context-video-hidestats",
                  this.onVideo && this.target.controls && statsShowing);

    // Disable them when there isn't a valid media source loaded.
    if (onMedia) {
      this.setItemAttr("context-media-playbackrate-050", "checked", this.target.playbackRate == 0.5);
      this.setItemAttr("context-media-playbackrate-100", "checked", this.target.playbackRate == 1.0);
      this.setItemAttr("context-media-playbackrate-125", "checked", this.target.playbackRate == 1.25);
      this.setItemAttr("context-media-playbackrate-150", "checked", this.target.playbackRate == 1.5);
      this.setItemAttr("context-media-playbackrate-200", "checked", this.target.playbackRate == 2.0);
      this.setItemAttr("context-media-loop", "checked", this.target.loop);
      var hasError = this.target.error != null ||
                     this.target.networkState == this.target.NETWORK_NO_SOURCE;
      this.setItemAttr("context-media-play", "disabled", hasError);
      this.setItemAttr("context-media-pause", "disabled", hasError);
      this.setItemAttr("context-media-mute", "disabled", hasError);
      this.setItemAttr("context-media-unmute", "disabled", hasError);
      this.setItemAttr("context-media-playbackrate", "disabled", hasError);
      this.setItemAttr("context-media-showcontrols", "disabled", hasError);
      this.setItemAttr("context-media-hidecontrols", "disabled", hasError);
      if (this.onVideo) {
        let canSave = this.target.readyState >= this.target.HAVE_CURRENT_DATA;
        this.setItemAttr("context-video-saveimage", "disabled", !canSave);
        this.setItemAttr("context-video-fullscreen", "disabled", hasError);
        this.setItemAttr("context-video-showstats", "disabled", hasError);
        this.setItemAttr("context-video-hidestats", "disabled", hasError);
      }
    }
    this.showItem("context-media-sep-commands", onMedia);
  },

  initPasswordManagerItems: function() {
    let fillMenu = document.getElementById("fill-login");
    // If no fill Menu, probably mailContext so nothing to set up.
    if (!fillMenu)
      return;

    let loginFillInfo = gContextMenuContentData && gContextMenuContentData.loginFillInfo;

    // If we could not find a password field we
    // don't want to show the form fill option.
    let showFill = loginFillInfo && loginFillInfo.passwordField.found;

    // Disable the fill option if the user has set a master password
    // or if the password field or target field are disabled.
    let disableFill = !loginFillInfo ||
                      !Services.logins ||
                      !Services.logins.isLoggedIn ||
                      loginFillInfo.passwordField.disabled ||
                      (!this.onPassword && loginFillInfo.usernameField.disabled);

    this.showItem("fill-login-separator", showFill);
    this.showItem("fill-login", showFill);
    this.setItemAttr("fill-login", "disabled", disableFill);

    // Set the correct label for the fill menu
    if (this.onPassword) {
      fillMenu.setAttribute("label", fillMenu.getAttribute("label-password"));
      fillMenu.setAttribute("accesskey", fillMenu.getAttribute("accesskey-password"));
    } else {
      fillMenu.setAttribute("label", fillMenu.getAttribute("label-login"));
      fillMenu.setAttribute("accesskey", fillMenu.getAttribute("accesskey-login"));
    }

    if (!showFill || disableFill) {
      return;
    }
    let documentURI = gContextMenuContentData.documentURIObject;
    let fragment = LoginManagerContextMenu.addLoginsToMenu(this.target, this.browser, documentURI);

    this.showItem("fill-login-no-logins", !fragment);

    if (!fragment) {
      return;
    }
    let popup = document.getElementById("fill-login-popup");
    let insertBeforeElement = document.getElementById("fill-login-no-logins");
    popup.insertBefore(fragment, insertBeforeElement);
  },

  openPasswordManager: function() {
    // LoginHelper.openPasswordManager(window, gContextMenuContentData.documentURIObject.host);
    toDataManager(gContextMenuContentData.documentURIObject.host + '|passwords');
  },

  /**
   * Retrieve the array of CSS selectors corresponding to the provided node. The first item
   * of the array is the selector of the node in its owner document. Additional items are
   * used if the node is inside a frame, each representing the CSS selector for finding the
   * frame element in its parent document.
   *
   * This format is expected by DevTools in order to handle the Inspect Node context menu
   * item.
   *
   * @param  {Node}
   *         The node for which the CSS selectors should be computed
   * @return {Array} array of css selectors (strings).
   */
  getNodeSelectors: function(node) {
    let selectors = [];
    while (node) {
      selectors.push(findCssSelector(node));
      node = node.ownerGlobal.frameElement;
    }

    return selectors;
  },

  inspectNode: function() {
    let gBrowser = this.browser.ownerDocument.defaultView.gBrowser;
    return DevToolsShim.inspectNode(gBrowser.selectedTab,
                                    this.getNodeSelectors(this.target));
  },

  // Set various context menu attributes based on the state of the world.
  setTarget: function(aNode, aRangeParent, aRangeOffset) {
    // Currently "isRemote" is always false.
    //this.isRemote = gContextMenuContentData && gContextMenuContentData.isRemote;

    const xulNS = "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";

    // Initialize contextual info.
    this.onImage               = false;
    this.onLoadedImage         = false;
    this.onCompletedImage      = false;
    this.onStandaloneImage     = false;
    this.onCanvas              = false;
    this.onVideo               = false;
    this.onAudio               = false;
    this.onMetaDataItem        = false;
    this.onTextInput           = false;
    this.onNumeric             = false;
    this.onKeywordField        = false;
    this.mediaURL              = "";
    this.onLink                = false;
    this.onMailtoLink          = false;
    this.onSaveableLink        = false;
    this.inDirList             = false;
    this.link                  = null;
    this.linkURL               = "";
    this.linkURI               = null;
    this.linkProtocol          = "";
    this.linkHasNoReferrer     = false;
    this.onMathML              = false;
    this.inFrame               = false;
    this.inSyntheticDoc        = false;
    this.hasBGImage            = false;
    this.bgImageURL            = "";
    this.autoDownload          = false;
    this.isTextSelected        = false;
    this.isContentSelected     = false;
    this.onEditableArea        = false;
    this.canSpellCheck         = false;
    this.onPassword            = false;

    // Remember the node that was clicked.
    this.target = aNode;

    if (aNode.nodeType == Node.DOCUMENT_NODE ||
        // Not display on XUL element but relax for <label class="text-link">
        (aNode.namespaceURI == xulNS && !isXULTextLinkLabel(aNode))) {
      this.shouldDisplay = false;
      return;
    }

    let editFlags = SpellCheckHelper.isEditable(this.target, window);
    this.browser = this.target.ownerDocument.defaultView
                              .QueryInterface(Ci.nsIInterfaceRequestor)
                              .getInterface(Ci.nsIWebNavigation)
                              .QueryInterface(Ci.nsIDocShell)
                              .chromeEventHandler;
    this.principal = this.target.ownerDocument.nodePrincipal;

    this.autoDownload = Services.prefs.getBoolPref("browser.download.useDownloadDir");

    // Check if we are in a synthetic document (stand alone image, video, etc.).
    this.inSyntheticDoc = this.target.ownerDocument.mozSyntheticDocument;
    // First, do checks for nodes that never have children.
    if (this.target.nodeType == Node.ELEMENT_NODE) {
      // See if the user clicked on an image.
      if (this.target instanceof Ci.nsIImageLoadingContent &&
          this.target.currentURI) {
        this.onImage = true;

        var request =
          this.target.getRequest(Ci.nsIImageLoadingContent.CURRENT_REQUEST);
        if (request && (request.imageStatus & request.STATUS_SIZE_AVAILABLE))
          this.onLoadedImage = true;
        if (request &&
            (request.imageStatus & request.STATUS_LOAD_COMPLETE) &&
            !(request.imageStatus & request.STATUS_ERROR)) {
          this.onCompletedImage = true;
        }

        this.mediaURL = this.target.currentURI.spec;

        if (this.target.ownerDocument instanceof ImageDocument)
          this.onStandaloneImage = true;
      }
      else if (this.target instanceof HTMLCanvasElement) {
        this.onCanvas = true;
      }
      else if (this.target instanceof HTMLVideoElement) {
        // Gecko always creates a HTMLVideoElement when loading an ogg file
        // directly. If the media is actually audio, be smarter and provide
        // a context menu with audio operations.
        if (this.target.readyState >= this.target.HAVE_METADATA &&
            (this.target.videoWidth == 0 || this.target.videoHeight == 0))
          this.onAudio = true;
        else
          this.onVideo = true;

        this.mediaURL = this.target.currentSrc || this.target.src;
      }
      else if (this.target instanceof HTMLAudioElement) {
        this.onAudio = true;
        this.mediaURL = this.target.currentSrc || this.target.src;
      }
      else if (editFlags & (SpellCheckHelper.INPUT | SpellCheckHelper.TEXTAREA)) {
        this.onTextInput = (editFlags & SpellCheckHelper.TEXTINPUT) !== 0;
        this.onNumeric = (editFlags & SpellCheckHelper.NUMERIC) !== 0;
        this.onEditableArea = (editFlags & SpellCheckHelper.EDITABLE) !== 0;
        this.onPassword = (editFlags & SpellCheckHelper.PASSWORD) !== 0;
        if (this.onEditableArea) {
          InlineSpellCheckerUI.init(this.target.editor);
          InlineSpellCheckerUI.initFromEvent(aRangeParent, aRangeOffset);
        }
        this.onKeywordField = (editFlags & SpellCheckHelper.KEYWORD);
      }
      else if ( this.target instanceof HTMLHtmlElement ) {
        // pages with multiple <body>s are lame. we'll teach them a lesson.
        var bodyElt = this.target.ownerDocument.body;
        if (bodyElt) {
          var computedURL = this.getComputedURL(bodyElt, "background-image");
          if (computedURL) {
            this.hasBGImage = true;
            this.bgImageURL = makeURLAbsolute(bodyElt.baseURI, computedURL);
          }
        }
      }
      else if ("HTTPIndex" in content &&
               content.HTTPIndex instanceof Ci.nsIHTTPIndex) {
        this.inDirList = true;
        // Bubble outward till we get to an element with URL attribute
        // (which should be the href).
        var root = this.target;
        while (root && !this.link) {
          if (root.tagName == "tree") {
            // Hit root of tree; must have clicked in empty space;
            // thus, no link.
            break;
          }

          if (root.getAttribute("URL")) {
            // Build pseudo link object so link-related functions work.
            this.onLink = true;
            this.link = {href: root.getAttribute("URL"),
                         getAttribute: function(attr) {
                           if (attr == "title") {
                             return root.firstChild.firstChild.getAttribute("label");
                           } else {
                             return "";
                           }
                         }
                        };
            this.linkURL = this.getLinkURL();
            this.linkURI = this.getLinkURI();
            this.linkProtocol = this.getLinkProtocol();
            this.onMailtoLink = (this.linkProtocol == "mailto");

            // If element is a directory, then you can't save it.
            this.onSaveableLink = root.getAttribute("container") != "true";
          }
          else {
            root = root.parentNode;
          }
        }
      }

      this.canSpellCheck = this._isSpellCheckEnabled(this.target);
    }
    else if (this.target.nodeType == Node.TEXT_NODE) {
      // For text nodes, look at the parent node to determine the spellcheck attribute.
      this.canSpellCheck = this.target.parentNode &&
                           this._isSpellCheckEnabled(this.target);
    }

    // We have meta data on images.
    this.onMetaDataItem = this.onImage;

    // Bubble out, looking for items of interest
    const NS_MathML = "http://www.w3.org/1998/Math/MathML";
    const XMLNS = "http://www.w3.org/XML/1998/namespace";
    var elem = this.target;
    while (elem) {
      if (elem.nodeType == Node.ELEMENT_NODE) {
        // Link?
        if (!this.onLink &&
            (isXULTextLinkLabel(elem) ||
             (elem instanceof HTMLAnchorElement && elem.href) ||
             (elem instanceof HTMLAreaElement && elem.href) ||
             elem instanceof HTMLLinkElement ||
             (elem.namespaceURI == NS_MathML && elem.hasAttribute("href")) ||
             elem.getAttributeNS("http://www.w3.org/1999/xlink", "type") == "simple")) {
          // Clicked on a link.
          this.onLink = true;
          this.onMetaDataItem = true;
          // Remember corresponding element.
          this.link = elem;
          this.linkURL = this.getLinkURL();
          this.linkURI = this.getLinkURI();
          this.linkProtocol = this.getLinkProtocol();
          this.onMailtoLink = (this.linkProtocol == "mailto");
          // Remember if it is saveable.
          this.onSaveableLink = this.isLinkSaveable();
          this.linkHasNoReferrer = BrowserUtils.linkHasNoReferrer(elem);
        }

        // Text input?
        if (!this.onTextInput) {
          // Clicked on a link.
          this.onTextInput = this.isTargetATextBox(elem);
        }

        // Metadata item?
        if (!this.onMetaDataItem) {
          // We currently display metadata on anything which fits
          // the below test.
          if ((elem instanceof HTMLQuoteElement && elem.cite) ||
              (elem instanceof HTMLTableElement && elem.summary) ||
              (elem instanceof HTMLModElement && (elem.cite || elem.dateTime)) ||
              (elem instanceof HTMLElement && (elem.title || elem.lang)) ||
              elem.getAttributeNS(XMLNS, "lang")) {
            dump("On metadata item.\n");
            this.onMetaDataItem = true;
          }
        }

        // Background image?  Don't bother if we've already found a
        // background image further down the hierarchy.  Otherwise,
        // we look for the computed background-image style.
        if (!this.hasBGImage) {
          var bgImgUrl = this.getComputedURL(elem, "background-image");
          if (bgImgUrl) {
            this.hasBGImage = true;
            this.bgImageURL = makeURLAbsolute(elem.baseURI, bgImgUrl);
          }
        }
      }
      elem = elem.parentNode;
    }

    // See if the user clicked on MathML
    if ((this.target.nodeType == Node.TEXT_NODE &&
         this.target.parentNode.namespaceURI == NS_MathML) ||
        (this.target.namespaceURI == NS_MathML))
      this.onMathML = true;

    // See if the user clicked in a frame.
    var docDefaultView = this.target.ownerDocument.defaultView;
    if (docDefaultView != docDefaultView.top)
      this.inFrame = true;

    // if the document is editable, show context menu like in text inputs
    if (!this.onEditableArea) {
      if (editFlags & SpellCheckHelper.CONTENTEDITABLE) {
        // If this.onEditableArea is false but editFlags is CONTENTEDITABLE,
        // then the document itself must be editable.
        this.onTextInput       = true;
        this.onKeywordField    = false;
        this.onImage           = false;
        this.onLoadedImage     = false;
        this.onCompletedImage  = false;
        this.onMathML          = false;
        this.inFrame           = false;
        this.hasBGImage        = false;
        this.onEditableArea    = true;
        var win = this.target.ownerDocument.defaultView;
        var editingSession = win.QueryInterface(Ci.nsIInterfaceRequestor)
                                .getInterface(Ci.nsIWebNavigation)
                                .QueryInterface(Ci.nsIInterfaceRequestor)
                                .getInterface(Ci.nsIEditingSession);
        InlineSpellCheckerUI.init(editingSession.getEditorForWindow(win));
        InlineSpellCheckerUI.initFromEvent(aRangeParent, aRangeOffset);
        var canSpell = InlineSpellCheckerUI.canSpellCheck && this.canSpellCheck;
        this.showItem("spell-check-enabled", canSpell);
        this.showItem("spell-separator", canSpell);
      }
    }

    function isXULTextLinkLabel(node) {
      return node.namespaceURI == xulNS &&
             node.tagName == "label" &&
             node.classList.contains('text-link') &&
             node.href;
    }
  },

  _isSpellCheckEnabled: function(aNode) {
    // We can always force-enable spellchecking on textboxes
    if (this.isTargetATextBox(aNode)) {
      return true;
    }
    // We can never spell check something which is not content editable
    var editable = aNode.isContentEditable;
    if (!editable && aNode.ownerDocument) {
      editable = aNode.ownerDocument.designMode == "on";
    }
    if (!editable) {
      return false;
    }
    // Otherwise make sure that nothing in the parent chain disables spellchecking
    return aNode.spellcheck;
  },

  // Returns the computed style attribute for the given element.
  getComputedStyle: function(aElem, aProp) {
    return aElem.ownerDocument
                .defaultView
                .getComputedStyle(aElem, "").getPropertyValue(aProp);
  },

  // Returns a "url"-type computed style attribute value, with the url() stripped.
  getComputedURL: function(aElem, aProp) {
    var url = aElem.ownerDocument.defaultView
                   .getComputedStyle(aElem, "")
                   .getPropertyCSSValue(aProp);
    if (url instanceof CSSPrimitiveValue)
      url = [url];

    for (var i = 0; i < url.length; i++)
      if (url[i].primitiveType == CSSPrimitiveValue.CSS_URI)
        return url[i].getStringValue();
    return null;
  },

  // Returns true if clicked-on link targets a resource that can be saved.
  isLinkSaveable: function() {
    return this.linkProtocol && this.linkProtocol != "mailto" &&
           this.linkProtocol != "javascript";
  },

  // Block/Unblock image from loading in the future.
  toggleImageBlocking: function(aBlock) {
  const uri = Services.io.newURI(this.mediaURL);
  if (aBlock)
    Services.perms.add(uri, "image", Services.perms.DENY_ACTION);
  else
    Services.perms.remove(uri, "image");
  },

  _openLinkInParameters : function (extra) {
    let params = { charset: gContextMenuContentData.charSet,
                   originPrincipal: this.principal,
                   triggeringPrincipal: this.principal,
                   referrerURI: gContextMenuContentData.documentURIObject,
                   referrerPolicy: gContextMenuContentData.referrerPolicy,
                   noReferrer: this.linkHasNoReferrer || this.onPlainTextLink };
    for (let p in extra) {
      params[p] = extra[p];
    }

    // If we want to change userContextId, we must be sure that we don't
    // propagate the referrer.
    if ("userContextId" in params &&
        params.userContextId != this.principal.originAttributes.userContextId) {
      params.noReferrer = true;
    }

    return params;
  },

  // Open linked-to URL in a new tab.
  openLinkInTab: function(aEvent) {
    urlSecurityCheck(this.linkURL, this.principal);
    let referrerURI = gContextMenuContentData.documentURIObject;

    // if the mixedContentChannel is present and the referring URI passes
    // a same origin check with the target URI, we can preserve the users
    // decision of disabling MCB on a page for it's child tabs.
    let persistAllowMixedContentInChildTab = false;

    if (this.browser.docShell.mixedContentChannel) {
      const sm = Services.scriptSecurityManager;
      try {
        let targetURI = this.linkURI;
        sm.checkSameOriginURI(referrerURI, targetURI, false);
        persistAllowMixedContentInChildTab = true;
      }
      catch (e) { }
    }

    let params = {
      allowMixedContent: persistAllowMixedContentInChildTab,
      userContextId: parseInt(aEvent.target.getAttribute('usercontextid')),
    };

    openLinkIn(this.linkURL,
               aEvent && aEvent.shiftKey ? "tabshifted" : "tab",
               this._openLinkInParameters(params));
  },

  // Open linked-to URL in a new window.
  openLinkInWindow: function() {
    urlSecurityCheck(this.linkURL, this.principal);
    openLinkIn(this.linkURL, "window", this._openLinkInParameters());
  },

  // Open linked-to URL in a private window.
  openLinkInPrivateWindow: function() {
    urlSecurityCheck(this.linkURL, this.principal);
    openLinkIn(this.linkURL, "window",
               this._openLinkInParameters({ private: true }));
  },

  // Open frame in a new tab.
  openFrameInTab: function(aEvent) {
    let referrer = gContextMenuContentData.referrer;
    openLinkIn(gContextMenuContentData.docLocation,
               aEvent && aEvent.shiftKey ? "tabshifted" : "tab",
               { charset: gContextMenuContentData.charSet,
                 referrerURI: referrer ? makeURI(referrer) : null });
  },

  // Reload clicked-in frame.
  reloadFrame: function() {
    this.target.ownerDocument.location.reload();
  },

  // Open clicked-in frame in its own window.
  openFrame: function() {
    let referrer = gContextMenuContentData.referrer;
    openLinkIn(gContextMenuContentData.docLocation, "window",
               { charset: gContextMenuContentData.charSet,
                 referrerURI: referrer ? makeURI(referrer) : null });
  },

  printFrame: function() {
    PrintUtils.printWindow(gContextMenuContentData.frameOuterWindowID,
                           this.browser);
  },

  // Open clicked-in frame in the same window
  showOnlyThisFrame: function() {
    urlSecurityCheck(gContextMenuContentData.docLocation,
                     this.principal,
                     Ci.nsIScriptSecurityManager.DISALLOW_SCRIPT);
    let referrer = gContextMenuContentData.referrer;
    openUILinkIn(gContextMenuContentData.docLocation, "current",
                 { disallowInheritPrincipal: true,
                   referrerURI: referrer ? makeURI(referrer) : null });
  },

  // View Partial Source
  viewPartialSource: function(aContext) {
    var browser = getBrowser().selectedBrowser;
    var target = aContext == "mathml" ? this.target : null;
    gViewSourceUtils.viewPartialSourceInBrowser(browser, target, null);
  },

  // Open new "view source" window with the frame's URL.
  viewFrameSource: function() {
    gViewSourceUtils.viewSource({
      browser: this.browser,
      URL: gContextMenuContentData.docLocation,
      outerWindowID: gContextMenuContentData.frameOuterWindowID,
    });
  },

  viewInfo: function() {
    BrowserPageInfo(gContextMenuContentData.docLocation, null,
                    null, null, this.browser);
  },

  viewImageInfo: function() {
    BrowserPageInfo(gContextMenuContentData.docLocation, "mediaTab",
                    this.target, null, this.browser);
  },

  viewFrameInfo: function() {
    BrowserPageInfo(gContextMenuContentData.docLocation, null, null,
                    gContextMenuContentData.frameOuterWindowID, this.browser);
  },

  toggleImageSize: function() {
    content.document.toggleImageSize();
  },

  // Reload image
  reloadImage: function() {
    urlSecurityCheck(this.mediaURL,
                     this.target.nodePrincipal,
                     Ci.nsIScriptSecurityManager.DISALLOW_SCRIPT);
    if (this.target instanceof Ci.nsIImageLoadingContent)
      this.target.forceReload();
  },

  // Change current window to the URL of the image, video, or audio.
  viewMedia(e) {
    let doc = this.target.ownerDocument;
    let where = whereToOpenLink(e);

    if (this.onCanvas) {
      let systemPrincipal = Services.scriptSecurityManager
                                    .getSystemPrincipal();
      this.target.toBlob((blob) => {
        openUILinkIn(URL.createObjectURL(blob), where,
                     { referrerURI: doc.documentURIObject,
                       triggeringPrincipal: systemPrincipal,
                     });
     });
    } else {
      urlSecurityCheck(this.mediaURL,
                       this.target.nodePrincipal,
                       Ci.nsIScriptSecurityManager.DISALLOW_SCRIPT);
      openUILinkIn(this.mediaURL, where,
                   { referrerURI: doc.documentURIObject,
                     forceAllowDataURI: true,
                     triggeringPrincipal: this.target.nodePrincipal,
                   });
    }
  },

  saveVideoFrameAsImage: function () {
    urlSecurityCheck(this.mediaURL, this.browser.contentPrincipal,
                     Ci.nsIScriptSecurityManager.DISALLOW_SCRIPT);
    var name = "snapshot.jpg";
    try {
      let uri = makeURI(this.mediaURL);
      let url = uri.QueryInterface(Ci.nsIURL);
      if (url.fileBaseName)
        name = decodeURI(url.fileBaseName) + ".jpg";
    } catch (e) { }
    var video = this.target;
    var canvas = document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    var ctxDraw = canvas.getContext("2d");
    ctxDraw.drawImage(video, 0, 0);
    saveImageURL(canvas.toDataURL("image/jpeg", ""), name, "SaveImageTitle",
                                  true, true,
                                  this.target.ownerDocument.documentURIObject,
                                  null, null, null, (gPrivate ? true : false),
                                  this.principal);
  },

  // Full screen video playback
  fullScreenVideo: function() {
    var isPaused = this.target.paused && this.target.currentTime > 0;
    this.target.pause();

    openDialog("chrome://communicator/content/fullscreen-video.xhtml",
               "", "chrome,centerscreen,dialog=no", this.target, isPaused);
  },

  // Change current window to the URL of the background image.
  viewBGImage(e) {
    urlSecurityCheck(this.bgImageURL,
                     this.target.nodePrincipal,
                     Ci.nsIScriptSecurityManager.DISALLOW_SCRIPT);

    let doc = this.target.ownerDocument;
    let where = whereToOpenLink(e);
    openUILinkIn(this.bgImageURL, where,
                 { referrerURI: doc.documentURIObject,
                   triggeringPrincipal: this.target.nodePrincipal,
                 });
  },

  setDesktopBackground: function() {
    let url = (new URL(this.target.ownerDocument.location.href)).pathname;
    let imageName = url.substr(url.lastIndexOf("/") + 1);
    openDialog("chrome://communicator/content/setDesktopBackground.xul",
               "_blank", "chrome,modal,titlebar,centerscreen", this.target,
               imageName);
  },

  // Save URL of clicked-on frame.
  saveFrame: function() {
    saveDocument(this.target.ownerDocument, true);
  },

  // Save URL of clicked-on link.
  saveLink: function() {
    var doc = this.target.ownerDocument;
    urlSecurityCheck(this.linkURL, this.principal);
    this.saveHelper(this.linkURL, this.linkText(), null, true, doc);
  },

  // Helper function to wait for appropriate MIME-type headers and
  // then prompt the user with a file picker
  saveHelper: function(linkURL, linkText, dialogTitle, bypassCache, doc) {
    // canonical def in nsURILoader.h
    const NS_ERROR_SAVE_LINK_AS_TIMEOUT = 0x805d0020;

    // an object to proxy the data through to
    // nsIExternalHelperAppService.doContent, which will wait for the
    // appropriate MIME-type headers and then prompt the user with a
    // file picker
    function SaveAsListener() {}
    SaveAsListener.prototype = {
      extListener: null,

      onStartRequest: function onStartRequest(aRequest, aContext) {
        // If the timer fired, the error status will have been caused by that,
        // and we'll be restarting in onStopRequest, so no reason to notify
        // the user.
        if (aRequest.status == NS_ERROR_SAVE_LINK_AS_TIMEOUT)
          return;

        clearTimeout(timer);

        // some other error occured; notify the user...
        if (!Components.isSuccessCode(aRequest.status)) {
          try {
            const bundle = Services.strings.createBundle(
                    "chrome://mozapps/locale/downloads/downloads.properties");

            const title = bundle.GetStringFromName("downloadErrorAlertTitle");
            const msg = bundle.GetStringFromName("downloadErrorGeneric");

            Services.prompt.alert(doc.defaultView, title, msg);
          } catch (ex) {}
          return;
        }

        var extHelperAppSvc =
          Cc["@mozilla.org/uriloader/external-helper-app-service;1"]
            .getService(Ci.nsIExternalHelperAppService);
        var channel = aRequest.QueryInterface(Ci.nsIChannel);
        this.extListener = extHelperAppSvc.doContent(channel.contentType, aRequest,
                                                     doc.defaultView, true);
        this.extListener.onStartRequest(aRequest, aContext);
      },

      onStopRequest: function onStopRequest(aRequest, aContext, aStatusCode) {
        if (aStatusCode == NS_ERROR_SAVE_LINK_AS_TIMEOUT) {
          // Do it the old fashioned way, which will pick the best filename
          // it can without waiting.
          saveURL(linkURL, linkText, dialogTitle, bypassCache, true, doc.documentURIObject, doc);
        }
        if (this.extListener)
          this.extListener.onStopRequest(aRequest, aContext, aStatusCode);
      },

      onDataAvailable: function onDataAvailable(aRequest, aContext, aInputStream,
                                                aOffset, aCount) {
        this.extListener.onDataAvailable(aRequest, aContext, aInputStream,
                                         aOffset, aCount);
      }
    }

    function Callbacks() {}
    Callbacks.prototype = {
      getInterface: function getInterface(aIID) {
        if (aIID.equals(Ci.nsIAuthPrompt) ||
            aIID.equals(Ci.nsIAuthPrompt2)) {
          // If the channel demands authentication prompt, we must cancel it
          // because the save-as-timer would expire and cancel the channel
          // before we get credentials from user.  Both authentication dialog
          // and save as dialog would appear on the screen as we fall back to
          // the old fashioned way after the timeout.
          timer.cancel();
          channel.cancel(NS_ERROR_SAVE_LINK_AS_TIMEOUT);
        }
        throw Cr.NS_ERROR_NO_INTERFACE;
      }
    }

    // If we don't have the headers after a short time the user won't have
    // received any feedback from the click. That's bad, so we give up
    // waiting for the filename.
    function timerCallback() {
      channel.cancel(NS_ERROR_SAVE_LINK_AS_TIMEOUT);
    }

    // set up a channel to do the saving
    var channel = NetUtil.newChannel({
                    uri: makeURI(linkURL),
                    loadingPrincipal: this.principal,
                    contentPolicyType: Ci.nsIContentPolicy.TYPE_SAVEAS_DOWNLOAD,
                    securityFlags: Ci.nsILoadInfo.SEC_ALLOW_CROSS_ORIGIN_SEC_CONTEXT_IS_NULL
                  });

    channel.notificationCallbacks = new Callbacks();

    var flags = Ci.nsIChannel.LOAD_CALL_CONTENT_SNIFFERS;

    if (bypassCache)
      flags |= Ci.nsIRequest.LOAD_BYPASS_CACHE;

    if (channel instanceof Ci.nsICachingChannel)
      flags |= Ci.nsICachingChannel.LOAD_BYPASS_LOCAL_CACHE_IF_BUSY;

    channel.loadFlags |= flags;

    if (channel instanceof Ci.nsIPrivateBrowsingChannel)
      channel.setPrivate(gPrivate);

    if (channel instanceof Ci.nsIHttpChannel) {
      channel.referrer = doc.documentURIObject;
      if (channel instanceof Ci.nsIHttpChannelInternal)
        channel.forceAllowThirdPartyCookie = true;
    }

    // fallback to the old way if we don't see the headers quickly
    var timeToWait = Services.prefs.getIntPref("browser.download.saveLinkAsFilenameTimeout");
    var timer = setTimeout(timerCallback, timeToWait);

    // kick off the channel with our proxy object as the listener
    channel.asyncOpen2(new SaveAsListener());
  },

  // Save URL of clicked-on image, video, or audio.
  saveMedia: function() {
    var doc = this.target.ownerDocument;
    let referrerURI = doc.documentURIObject;

    if (this.onCanvas)
      // Bypass cache, since it's a data: URL.
      saveImageURL(this.target.toDataURL(), "canvas.png", "SaveImageTitle",
                   true, false, referrerURI, null, null, null,
                   (gPrivate ? true : false),
                   document.nodePrincipal /* system, because blob: */);
    else if (this.onImage) {
      urlSecurityCheck(this.mediaURL, this.principal);
      saveImageURL(this.mediaURL, null, "SaveImageTitle", false,
                   false, referrerURI, null, gContextMenuContentData.contentType,
                   gContextMenuContentData.contentDisposition,
                   (gPrivate ? true : false),
                   this.principal);
    }
    else if (this.onVideo || this.onAudio) {
      urlSecurityCheck(this.mediaURL, this.principal);
      var dialogTitle = this.onVideo ? "SaveVideoTitle" : "SaveAudioTitle";
      this.saveHelper(this.mediaURL, null, dialogTitle, false, doc);
    }
  },

  // Backwards-compatibility wrapper
  saveImage: function() {
    if (this.onCanvas || this.onImage)
      this.saveMedia();
  },

  // Generate email address.
  getEmail: function() {
    // Get the comma-separated list of email addresses only.
    // There are other ways of embedding email addresses in a mailto:
    // link, but such complex parsing is beyond us.
    var addresses;
    try {
      // Let's try to unescape it using a character set
      var characterSet = this.target.ownerDocument.characterSet;
      const textToSubURI = Cc["@mozilla.org/intl/texttosuburi;1"]
                             .getService(Ci.nsITextToSubURI);
      addresses = this.linkURL.match(/^mailto:([^?]+)/)[1];
      addresses = textToSubURI.unEscapeURIForUI(characterSet, addresses);
    }
    catch(ex) {
      // Do nothing.
    }
    return addresses;
  },

  // Copy email to clipboard
  copyEmail: function() {
    var clipboard = Cc["@mozilla.org/widget/clipboardhelper;1"]
                      .getService(Ci.nsIClipboardHelper);
    clipboard.copyString(this.getEmail());
  },

  bookmarkThisPage : function() {
    window.top.PlacesCommandHook.bookmarkPage(this.browser,
                                              true);
  },

  bookmarkLink: function CM_bookmarkLink() {
    window.top.PlacesCommandHook.bookmarkLink(PlacesUtils.bookmarksMenuFolderId,
                                              this.linkURL,
                                              this.linkText());
  },

  addBookmarkForFrame: function() {
    var doc = this.target.ownerDocument;
    var uri = doc.documentURIObject;

    var itemId = PlacesUtils.getMostRecentBookmarkForURI(uri);
    if (itemId == -1) {
      var title = doc.title;
      var description = PlacesUIUtils.getDescriptionFromDocument(doc);
      PlacesUIUtils.showMinimalAddBookmarkUI(uri, title, description);
    }
    else
      PlacesUIUtils.showItemProperties(itemId,
                                       PlacesUtils.bookmarks.TYPE_BOOKMARK);
  },

  // Open Metadata window for node
  showMetadata: function() {
    window.openDialog("chrome://navigator/content/metadata.xul",
                      "_blank",
                      "scrollbars,resizable,chrome,dialog=no",
                      this.target);
  },

  ///////////////
  // Utilities //
  ///////////////

  // Show/hide one item (specified via name or the item element itself).
  showItem: function(aItemOrId, aShow) {
    var item = aItemOrId.constructor == String ? document.getElementById(aItemOrId) : aItemOrId;
    if (item)
      item.hidden = !aShow;
  },

  // Set given attribute of specified context-menu item.  If the
  // value is null, then it removes the attribute (which works
  // nicely for the disabled attribute).
  setItemAttr: function(aID, aAttr, aVal) {
    var elem = document.getElementById(aID);
    if (elem) {
      if (aVal == null) {
        // null indicates attr should be removed.
        elem.removeAttribute(aAttr);
      }
      else {
        // Set attr=val.
        elem.setAttribute(aAttr, aVal);
      }
    }
  },

  // Set context menu attribute according to like attribute of another node
  // (such as a broadcaster).
  setItemAttrFromNode: function(aItem_id, aAttr, aOther_id) {
    var elem = document.getElementById(aOther_id);
    if (elem && elem.getAttribute(aAttr) == "true") {
      this.setItemAttr(aItem_id, aAttr, "true");
    }
    else {
      this.setItemAttr(aItem_id, aAttr, null);
    }
  },

  // Temporary workaround for DOM api not yet implemented by XUL nodes.
  cloneNode: function(aItem) {
    // Create another element like the one we're cloning.
    var node = document.createElement(aItem.tagName);

    // Copy attributes from argument item to the new one.
    var attrs = aItem.attributes;
    for (var i = 0; i < attrs.length; i++) {
      var attr = attrs.item(i);
      node.setAttribute(attr.nodeName, attr.nodeValue);
    }

    // Voila!
    return node;
  },

  // Generate fully qualified URL for clicked-on link.
  getLinkURL: function() {
    if (this.link.href)
      return this.link.href;

    var href;
    if (this.link.namespaceURI == "http://www.w3.org/1998/Math/MathML")
      href = this.link.getAttribute("href");

    if (!href)
      href = this.link.getAttributeNS("http://www.w3.org/1999/xlink", "href");

    if (!href || !href.match(/\S/)) {
      // Without this we try to save as the current doc,
      // for example, HTML case also throws if empty
      throw "Empty href";
    }

    return makeURLAbsolute(this.link.baseURI, href);
  },

  getLinkURI: function() {
    try {
     return makeURI(this.linkURL);
    }
    catch (ex) {
     // e.g. empty URL string
    }

    return null;
  },

  getLinkProtocol: function() {
    if (this.linkURI)
      return this.linkURI.scheme; // can be |undefined|

    return null;
  },

  // Get text of link.
  linkText: function() {
    var text = gatherTextUnder(this.link);
    if (text && text.match(/\S/))
      return text;

    text = this.link.getAttribute("title");
    if (text && text.match(/\S/))
      return text;

    text = this.link.getAttribute("alt");
    if (text && text.match(/\S/))
      return text;

    if (this.link.href)
      return this.link.href;

    if (elem.namespaceURI == "http://www.w3.org/1998/Math/MathML")
      text = elem.getAttribute("href");
    if (!text || !text.match(/\S/))
      text = elem.getAttributeNS("http://www.w3.org/1999/xlink", "href");
    if (text && text.match(/\S/))
      return makeURLAbsolute(this.link.baseURI, text);

    return null;
  },

  /**
   * Determines whether the focused window has selected text, and if so
   * formats the first 15 characters for the label of the context-searchselect
   * element according to the searchText string.
   * @return true if there is selected text, false if not
   */
  isTextSelection: function() {
    var searchSelectText = this.searchSelected(16);

    if (!searchSelectText)
      return false;

    if (searchSelectText.length > 15)
      searchSelectText = searchSelectText.substr(0, 15) + this.ellipsis;

    let engineName = this.searchEngine().name;
    // format "Search <engine> for <selection>" string to show in menu
    const bundle = document.getElementById("contentAreaCommandsBundle");
    var menuLabel = bundle.getFormattedString("searchSelected",
                                              [engineName, searchSelectText]);
    this.setItemAttr("context-searchselect", "label", menuLabel);
    this.setItemAttr("context-searchselect", "accesskey",
                     bundle.getString("searchSelected.accesskey"));

    return true;
  },

  searchEngine: function() {
    // Use the current engine if it's a browser window and the search bar is
    // visible, the default engine otherwise.
    if (window.BrowserSearch && (isElementVisible(BrowserSearch.searchBar) ||
                                 BrowserSearch.searchSidebar)) {
      return Services.search.currentEngine;
    }

    return Services.search.defaultEngine;
  },

  searchSelected: function(aCharlen) {
    var focusedWindow = document.commandDispatcher.focusedWindow;
    var searchStr = focusedWindow.getSelection();
    searchStr = searchStr.toString();

    if (this.onTextInput) {
      var fElem = this.target;
      if ((fElem instanceof HTMLInputElement &&
           fElem.mozIsTextField(true)) ||
           fElem instanceof HTMLTextAreaElement) {
        searchStr = fElem.value.substring(fElem.selectionStart, fElem.selectionEnd);
      }
    }

    // searching for more than 150 chars makes no sense
    if (!aCharlen)
      aCharlen = 150;
    if (aCharlen < searchStr.length) {
      // only use the first charlen important chars. see bug 221361
      var pattern = new RegExp("^(?:\\s*.){0," + aCharlen + "}");
      pattern.test(searchStr);
      searchStr = RegExp.lastMatch;
    }

    return searchStr.trim().replace(/\s+/g, " ");
  },

  // Returns true if anything is selected.
  isContentSelection: function() {
    return !document.commandDispatcher.focusedWindow.getSelection().isCollapsed;
  },

  // Returns true if the target is editable
  isTargetEditable: function() {
    if (this.target.ownerDocument.designMode == "on")
      return true;

    for (var node = this.target; node; node = node.parentNode)
      if (node.nodeType == node.ELEMENT_NODE &&
          node.namespaceURI == "http://www.w3.org/1999/xhtml")
        return node.isContentEditable;
    return false;
  },

  toString: function() {
    return "contextMenu.target     = " + this.target + "\n" +
           "contextMenu.onImage    = " + this.onImage + "\n" +
           "contextMenu.onLink     = " + this.onLink + "\n" +
           "contextMenu.link       = " + this.link + "\n" +
           "contextMenu.inFrame    = " + this.inFrame + "\n" +
           "contextMenu.hasBGImage = " + this.hasBGImage + "\n";
  },

  isTextBoxEnabled: function(aNode) {
    return !aNode.ownerDocument.defaultView
                 .QueryInterface(Ci.nsIInterfaceRequestor)
                 .getInterface(Ci.nsIDOMWindowUtils)
                 .isNodeDisabledForEvents(aNode);
  },

  isTargetATextBox: function(aNode) {
    if (aNode instanceof HTMLInputElement)
      return aNode.mozIsTextField(false) && this.isTextBoxEnabled(aNode);

    return aNode instanceof HTMLTextAreaElement && this.isTextBoxEnabled(aNode);
  },

  /**
   * Determine whether a separator should be shown based on whether
   * there are any non-hidden items between it and the previous separator.
   * @param  aSeparatorID
   *         The id of the separator element
   * @return true if the separator should be shown, false if not
   */
  shouldShowSeparator: function(aSeparatorID) {
    let separator = document.getElementById(aSeparatorID);
    if (separator) {
      let sibling = separator.previousSibling;
      while (sibling && sibling.localName != "menuseparator") {
        if (sibling.getAttribute("hidden") != "true")
          return true;
        sibling = sibling.previousSibling;
      }
    }
    return false;
  },

  mediaCommand: function(aCommand, aData) {
    var media = this.target;

    switch (aCommand) {
      case "play":
        media.play();
        break;
      case "pause":
        media.pause();
        break;
      case "loop":
        media.loop = !media.loop;
        break;
      case "mute":
        media.muted = true;
        break;
      case "unmute":
        media.muted = false;
        break;
      case "playbackRate":
        media.playbackRate = aData;
        break;
      case "hidecontrols":
        media.removeAttribute("controls");
        break;
      case "showcontrols":
        media.setAttribute("controls", "true");
        break;
      case "showstats":
      case "hidestats":
        var win = media.ownerDocument.defaultView;
        var showing = aCommand == "showstats";
        media.dispatchEvent(new win.CustomEvent("media-showStatistics",
          { bubbles: false, cancelable: true, detail: showing }));
        break;
    }
  },

  copyMediaLocation: function() {
    var clipboard = Cc["@mozilla.org/widget/clipboardhelper;1"]
                    .getService(Ci.nsIClipboardHelper);
    clipboard.copyString(this.mediaURL);
  },

  get imageURL() {
    if (this.onImage)
      return this.mediaURL;
    return "";
  },

  openSearch: function(aEvent) {
    let submission = this.searchEngine().getSubmission(this.searchSelected());
    // If you change /suite/navigator/navigator.js->BrowserSearch::loadSearch()
    // make sure you make corresponding changes here.
    if (!submission) {
      return;
    }

    let newTabPref = Services.prefs.getBoolPref("browser.search.opentabforcontextsearch");
    let where = newTabPref ? aEvent && aEvent.shiftKey ? "tabshifted" : "tab" : "window";
    openUILinkIn(submission.uri.spec, where, null, submission.postData);
  },
};

XPCOMUtils.defineLazyGetter(nsContextMenu.prototype, "ellipsis", function() {
  return Services.prefs.getComplexValue("intl.ellipsis",
      Ci.nsIPrefLocalizedString).data;
});
