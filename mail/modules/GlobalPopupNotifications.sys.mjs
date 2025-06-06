/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** This file is a semi-fork of PopupNotifications.sys.mjs */

const NOTIFICATION_EVENT_DISMISSED = "dismissed";
const NOTIFICATION_EVENT_REMOVED = "removed";
const NOTIFICATION_EVENT_SHOWING = "showing";
const NOTIFICATION_EVENT_SHOWN = "shown";
const NOTIFICATION_EVENT_SWAPPING = "swapping";

const ICON_SELECTOR = ".notification-anchor-icon";
const ICON_ATTRIBUTE_SHOWING = "showing";

const PREF_SECURITY_DELAY = "security.notification_enable_delay";

var popupNotificationsMap = [];
var gNotificationParents = new WeakMap();

/**
 * Given a DOM node inside a <popupnotification>, return the parent <popupnotification>.
 */
function getNotificationFromElement(aElement) {
  return aElement.closest("popupnotification");
}

/**
 * Notification object describes a single popup notification.
 *
 * @see PopupNotifications.show()
 */
// eslint-disable-next-line no-shadow
function Notification(
  id,
  message,
  anchorID,
  mainAction,
  secondaryActions,
  browser,
  owner,
  options
) {
  this.id = id;
  this.message = message;
  this.anchorID = anchorID;
  this.mainAction = mainAction;
  this.secondaryActions = secondaryActions || [];
  this.browser = browser;
  this.owner = owner;
  this.options = options || {};

  this._dismissed = false;
  // Will become a boolean when manually toggled by the user.
  this._checkboxChecked = null;
  this.timeCreated = this.owner.window.performance.now();
}

Notification.prototype = {
  id: null,
  message: null,
  anchorID: null,
  mainAction: null,
  secondaryActions: null,
  browser: null,
  owner: null,
  options: null,
  timeShown: null,

  /**
   * Indicates whether the notification is currently dismissed.
   */
  set dismissed(value) {
    this._dismissed = value;
  },
  get dismissed() {
    return this._dismissed;
  },

  /**
   * Removes the notification and updates the popup accordingly if needed.
   */
  remove() {
    this.owner.remove(this);
  },

  get anchorElement() {
    const iconBox = this.owner.iconBox;
    return iconBox.querySelector("#" + this.anchorID);
  },

  reshow() {
    this.owner._reshowNotifications(this.anchorElement, this.browser);
  },
};

/**
 * The PopupNotifications object manages popup notifications for a given browser
 * window.
 *
 * @param {tabbrowser} tabbrowser - The window's TabBrowser. Used to observe tab
 *   switching events and for determining the active browser element.
 * @param {Element} panel - The <xul:panel/> element to use for notifications.
 *   The panel is populated with <popupnotification> children and displayed it
 *   as needed.
 * @param {Element} iconBox - Reference to a container element that should be
 *   hidden or unhidden when notifications are hidden or shown. It should be the
 *   parent of anchor elements whose IDs are passed to show().
 *   It is used as a fallback popup anchor if notifications specify invalid or
 *   non-existent anchor IDs.
 * @param {object} [options] - An optional object with the following properties
 * @param {function():boolean} [options.shouldSuppress] - If this function
 *   returns true, then all notifications are suppressed for this window.
 *   This state is checked on construction and when the "anchorVisibilityChange"
 *   method is called.
 */
export function PopupNotifications(tabbrowser, panel, iconBox, options = {}) {
  if (!tabbrowser) {
    throw new Error("Invalid tabbrowser");
  }
  if (iconBox && ChromeUtils.getClassName(iconBox) != "HTMLDivElement") {
    throw new Error("Invalid iconBox");
  }
  if (ChromeUtils.getClassName(panel) != "XULPopupElement") {
    throw new Error("Invalid panel");
  }

  this._shouldSuppress = options.shouldSuppress || (() => false);
  this._suppress = this._shouldSuppress();

  this.window = tabbrowser.ownerGlobal;
  this.panel = panel;
  this.tabbrowser = tabbrowser;
  this.iconBox = iconBox;
  this.buttonDelay = Services.prefs.getIntPref(PREF_SECURITY_DELAY);

  this.panel.addEventListener("popuphidden", this, true);
  this.panel.classList.add("popup-notification-panel", "panel-no-padding");

  // This listener will be attached to the chrome window whenever a notification
  // is showing, to allow the user to dismiss notifications using the escape key.
  this._handleWindowKeyPress = aEvent => {
    if (aEvent.keyCode != aEvent.DOM_VK_ESCAPE) {
      return;
    }

    // Esc key cancels the topmost notification, if there is one.
    const notification = this.panel.firstElementChild;
    if (!notification) {
      return;
    }

    const doc = this.window.document;
    const focusedElement = Services.focus.focusedElement;

    // If the chrome window has a focused element, let it handle the ESC key instead.
    if (
      !focusedElement ||
      focusedElement == doc.body ||
      focusedElement == this.tabbrowser.selectedBrowser ||
      notification.contains(focusedElement)
    ) {
      this._onButtonEvent(
        aEvent,
        "secondarybuttoncommand",
        "esc-press",
        notification
      );
    }
  };

  const documentElement = this.window.document.documentElement;
  const locationBarHidden = documentElement
    .getAttribute("chromehidden")
    .includes("location");
  const isFullscreen = !!this.window.document.fullscreenElement;

  this.panel.setAttribute("followanchor", !locationBarHidden && !isFullscreen);

  // There are no anchor icons in DOM fullscreen mode, but we would
  // still like to show the popup notification. To avoid an infinite
  // loop of showing and hiding, we have to disable followanchor
  // (which hides the element without an anchor) in fullscreen.
  this.window.addEventListener(
    "MozDOMFullscreen:Entered",
    () => {
      this.panel.setAttribute("followanchor", "false");
    },
    true
  );
  this.window.addEventListener(
    "MozDOMFullscreen:Exited",
    () => {
      this.panel.setAttribute("followanchor", !locationBarHidden);
    },
    true
  );

  this.window.addEventListener("activate", this, true);
  if (this.tabbrowser.tabContainer) {
    this.tabbrowser.tabContainer.addEventListener("TabSelect", this, true);
  }
}

PopupNotifications.prototype = {
  window: null,
  panel: null,
  tabbrowser: null,

  _iconBox: null,
  set iconBox(iconBox) {
    // Remove the listeners on the old iconBox, if needed
    if (this._iconBox) {
      this._iconBox.removeEventListener("click", this);
      this._iconBox.removeEventListener("keypress", this);
    }
    this._iconBox = iconBox;
    if (iconBox) {
      iconBox.addEventListener("click", this);
      iconBox.addEventListener("keypress", this);
    }
  },
  get iconBox() {
    return this._iconBox;
  },

  /**
   * Retrieve a Notification object associated with the browser/ID pair.
   *
   * @param {string} id - The Notification ID to search for.
   *
   * @returns {?Notification} the corresponding Notification object, or null
   *   if no such notification exists.
   */
  getNotification(id) {
    return popupNotificationsMap.find(x => x.id == id) || null;
  },

  /**
   * Adds a new popup notification.
   *
   * @param {Browser} browser - The <xul:browser> element associated with the
   *   notification. Must not be null.
   * @param {string} id - A unique ID that identifies the type of notification
   *   (e.g. "geolocation"). Only one notification with a given ID can be visible
   *   at a time. If a notification already exists with the given ID, it
   *   will be replaced.
   * @param {string} message - A string containing the text to be displayed as
   *   the notification header. The string may optionally contain "<>" as a
   *   placeholder which is later replaced by a host name or an addon name that
   *   is formatted to look bold, in which case the options.name property needs
   *   to be specified.
   * @param {?string} anchorID - The ID of the element that should be used as
   *   this notification popup's anchor.
   *   May be null, in which case the notification will be anchored to the iconBox.
   * @param {?object} [mainAction] - A JavaScript object describing the
   *   notification button's action. If present, it must have the following properties:
   *          - label (string): the button's label.
   *          - accessKey (string): the button's accessKey.
   *          - callback (function): a callback to be invoked when the button is
   *            pressed, is passed an object that contains the following fields:
   *              - checkboxChecked: (boolean) If the optional checkbox is checked.
   *              - source: (string): the source of the action that initiated the
   *                callback, either:
   *                - "button" if popup buttons were directly activated, or
   *                - "esc-press" if the user pressed the escape key, or
   *                - "menucommand" if a menu was activated.
   *          - [optional] dismiss (boolean): If this is true, the notification
   *            will be dismissed instead of removed after running the callback.
   *          - [optional] disableHighlight (boolean): If this is true, the button
   *            will not apply the default highlight style.
   *        If null, the notification will have a default "OK" action button
   *        that can be used to dismiss the popup and secondaryActions will be ignored.
   * @param {?object[]} [secondaryActions] An optional JavaScript array
   *   describing the notification's alternate actions. The array should contain
   *   objects with the same properties as mainAction. These are used to
   *   populate the notification button's dropdown menu.
   * @param {object} options - An options JavaScript object holding additional
   *   properties for the notification. The following properties are currently supported:
   *        persistence: An integer. The notification will not automatically
   *                     dismiss for this many page loads.
   *        timeout:     A time in milliseconds. The notification will not
   *                     automatically dismiss before this time.
   *        persistWhileVisible:
   *                     A boolean. If true, a visible notification will always
   *                     persist across location changes.
   *        persistent:  A boolean. If true, the notification will always
   *                     persist even across tab and app changes (but not across
   *                     location changes), until the user accepts or rejects
   *                     the request. The notification will never be implicitly
   *                     dismissed.
   *        dismissed:   Whether the notification should be added as a dismissed
   *                     notification. Dismissed notifications can be activated
   *                     by clicking on their anchorElement.
   *        autofocus:   Whether the notification should be autofocused on
   *                     showing, stealing focus from any other focused element.
   *        eventCallback:
   *                     Callback to be invoked when the notification changes
   *                     state. The callback's first argument is a string
   *                     identifying the state change:
   *                     "dismissed": notification has been dismissed by the
   *                                  user (e.g. by clicking away or switching
   *                                  tabs)
   *                     "removed": notification has been removed (due to
   *                                location change or user action)
   *                     "showing": notification is about to be shown
   *                                (this can be fired multiple times as
   *                                 notifications are dismissed and re-shown)
   *                                If the callback returns true, the notification
   *                                will be dismissed.
   *                     "shown": notification has been shown (this can be fired
   *                              multiple times as notifications are dismissed
   *                              and re-shown)
   *                     "swapping": the docshell of the browser that created
   *                                 the notification is about to be swapped to
   *                                 another browser. A second parameter contains
   *                                 the browser that is receiving the docshell,
   *                                 so that the event callback can transfer stuff
   *                                 specific to this notification.
   *                                 If the callback returns true, the notification
   *                                 will be moved to the new browser.
   *                                 If the callback isn't implemented, returns false,
   *                                 or doesn't return any value, the notification
   *                                 will be removed.
   *        neverShow:   Indicate that no popup should be shown for this
   *                     notification. Useful for just showing the anchor icon.
   *        removeOnDismissal:
   *                     Notifications with this parameter set to true will be
   *                     removed when they would have otherwise been dismissed
   *                     (i.e. any time the popup is closed due to user
   *                     interaction).
   *        hideClose:   Indicate that the little close button in the corner of
   *                     the panel should be hidden.
   *        checkbox:    An object that allows you to add a checkbox and
   *                     control its behavior with these fields:
   *                       label:
   *                         (required) Label to be shown next to the checkbox.
   *                       checked:
   *                         (optional) Whether the checkbox should be checked
   *                         by default. Defaults to false.
   *                       checkedState:
   *                         (optional) An object that allows you to customize
   *                         the notification state when the checkbox is checked.
   *                           disableMainAction:
   *                             (optional) Whether the mainAction is disabled.
   *                             Defaults to false.
   *                           warningLabel:
   *                             (optional) A (warning) text that is shown below the
   *                             checkbox. Pass null to hide.
   *                       uncheckedState:
   *                         (optional) An object that allows you to customize
   *                         the notification state when the checkbox is not checked.
   *                         Has the same attributes as checkedState.
   *        popupIconClass:
   *                     A string. A class (or space separated list of classes)
   *                     that will be applied to the icon in the popup so that
   *                     several notifications using the same panel can use
   *                     different icons.
   *        popupIconURL:
   *                     A string. URL of the image to be displayed in the popup.
   *                     Normally specified in CSS using list-style-image and the
   *                     .popup-notification-icon[popupid=...] selector.
   *        learnMoreURL:
   *                     A string URL. Setting this property will make the
   *                     prompt display a "Learn More" link that, when clicked,
   *                     opens the URL in a new tab.
   *        displayURI:
   *                     The nsIURI of the page the notification came
   *                     from. If present, this will be displayed above the message.
   *                     If the nsIURI represents a file, the path will be displayed,
   *                     otherwise the hostPort will be displayed.
   *        name:
   *                     An optional string formatted to look bold and used in the
   *                     notifiation description header text. Usually a host name or
   *                     addon name.
   * @returns {Notification} the Notification object corresponding to the added notification.
   */
  show(browser, id, message, anchorID, mainAction, secondaryActions, options) {
    function isInvalidAction(a) {
      return (
        !a || !(typeof a.callback == "function") || !a.label || !a.accessKey
      );
    }

    if (!id) {
      throw new Error("PopupNotifications_show: invalid ID");
    }
    if (mainAction && isInvalidAction(mainAction)) {
      throw new Error("PopupNotifications_show: invalid mainAction");
    }
    if (secondaryActions && secondaryActions.some(isInvalidAction)) {
      throw new Error("PopupNotifications_show: invalid secondaryActions");
    }

    const notification = new Notification(
      id,
      message,
      anchorID,
      mainAction,
      secondaryActions,
      browser,
      this,
      options
    );

    if (options && options.dismissed) {
      notification.dismissed = true;
    }

    const existingNotification = this.getNotification(id);
    if (existingNotification) {
      this._remove(existingNotification);
    }

    popupNotificationsMap.push(notification);

    const isActiveWindow = Services.focus.activeWindow == this.window;

    if (isActiveWindow) {
      // Autofocus if the notification requests focus.
      if (options && !options.dismissed && options.autofocus) {
        this.panel.removeAttribute("noautofocus");
      } else {
        this.panel.setAttribute("noautofocus", "true");
      }

      // show panel now
      this._update(
        popupNotificationsMap,
        new Set([notification.anchorElement]),
        true
      );
    } else {
      // indicate attention and update the icon if necessary
      if (!notification.dismissed) {
        this.window.getAttention();
      }
      this._updateAnchorIcons(
        popupNotificationsMap,
        this._getAnchorsForNotifications(
          popupNotificationsMap,
          notification.anchorElement
        )
      );
      this._notify("backgroundShow");
    }

    return notification;
  },

  /**
   * Returns {boolean} true if the notification popup is currently being displayed.
   */
  get isPanelOpen() {
    const panelState = this.panel.state;

    return panelState == "showing" || panelState == "open";
  },

  /**
   * Removes a Notification.
   *
   * @param {Notification} notification -The Notification object to remove.
   */
  remove(notification) {
    this._remove(notification);

    const notifications = this._getNotificationsForBrowser(
      notification.browser
    );
    this._update(notifications);
  },

  handleEvent(aEvent) {
    switch (aEvent.type) {
      case "popuphidden":
        this._onPopupHidden(aEvent);
        break;
      case "activate":
        if (this.isPanelOpen) {
          for (const elt of this.panel.children) {
            elt.notification.timeShown = this.window.performance.now();
          }
          break;
        }
      // Falls through
      case "TabSelect": {
        const self = this;
        // This is where we could detect if the panel is dismissed if the page
        // was switched. Unfortunately, the user usually has clicked elsewhere
        // at this point so this value only gets recorded for programmatic
        // reasons, like the "Learn More" link being clicked and resulting in a
        // tab switch.
        // setTimeout(..., 0) needed, otherwise openPopup from "activate" event
        // handler results in the popup being hidden again for some reason...
        this.window.setTimeout(function () {
          self._update();
        }, 0);
        break;
      }
      case "click":
      case "keypress":
        this._onIconBoxCommand(aEvent);
        break;
      case "buttoncommand":
        this._onButtonEvent(aEvent, "buttoncommand");
        break;
      case "secondarybuttoncommand":
        this._onButtonEvent(aEvent, "secondarybuttoncommand");
        break;
      case "learnmoreclick":
        this._onButtonEvent(aEvent, "learnmoreclick");
        break;
    }
  },

  // Utility methods

  _ignoreDismissal: null,
  _currentAnchorElement: null,

  /**
   * Gets notifications for the currently selected browser.
   */
  get _currentNotifications() {
    return this.tabbrowser.selectedBrowser
      ? this._getNotificationsForBrowser(this.tabbrowser.selectedBrowser)
      : [];
  },

  _remove(notification) {
    // This notification may already be removed, in which case let's just fail
    // silently.
    var index = popupNotificationsMap.indexOf(notification);
    if (index == -1) {
      return;
    }

    // remove the notification
    popupNotificationsMap.splice(index, 1);
    this._fireCallback(notification, NOTIFICATION_EVENT_REMOVED);
  },

  /**
   * Dismisses the notification without removing it.
   */
  _dismiss(event) {
    // An explicitly dismissed persistent notification effectively becomes
    // non-persistent.
    if (event) {
      const notificationEl = getNotificationFromElement(event.target);
      if (notificationEl) {
        notificationEl.notification.options.persistent = false;
      }
    }

    const browser =
      this.panel.firstElementChild &&
      this.panel.firstElementChild.notification.browser;
    this.panel.hidePopup();
    if (browser) {
      browser.focus();
    }
  },

  /**
   * Hides the notification popup.
   */
  _hidePanel() {
    if (this.panel.state == "closed") {
      return Promise.resolve();
    }
    if (this._ignoreDismissal) {
      return this._ignoreDismissal.promise;
    }
    const deferred = Promise.withResolvers();
    this._ignoreDismissal = deferred;
    this.panel.hidePopup();
    return deferred.promise;
  },

  /**
   * Removes all notifications from the notification popup.
   */
  _clearPanel() {
    let popupnotification;
    while ((popupnotification = this.panel.lastElementChild)) {
      this.panel.removeChild(popupnotification);

      // If this notification was provided by the chrome document rather than
      // created ad hoc, move it back to where we got it from.
      const originalParent = gNotificationParents.get(popupnotification);
      if (originalParent) {
        popupnotification.notification = null;

        // Re-hide the notification such that it isn't rendered in the chrome
        // document. _refreshPanel will unhide it again when needed.
        popupnotification.hidden = true;

        originalParent.appendChild(popupnotification);
      }
    }
  },

  /**
   * Formats the notification description message before we display it
   * and splits it into three parts if the message contains "<>" as
   * placeholder.
   *
   * @param {Notification} n - The object which contains the message to format.
   *
   * @returns {object} object - an object that has the following properties:
   * @returns {string} object.start - A start label string containing the first part
   *   of the message. It may contain the whole string if the description message
   *   does not have "<>" as a placeholder. For example, local file URIs with
   *   description messages that don't display hostnames.
   * @returns {string} object.name - A string that is formatted to look bold.
   *   It replaces the placeholder with the options.name property from the
   *   notification object which is usually an addon name or a host name.
   * @returns {string} object.end - The last part of the description message.
   */
  _formatDescriptionMessage(n) {
    const text = {};
    const array = n.message.split("<>");
    text.start = array[0] || "";
    text.name = n.options.name || "";
    text.end = array[1] || "";
    return text;
  },

  _refreshPanel(notificationsToShow) {
    this._clearPanel();

    notificationsToShow.forEach(function (n) {
      const doc = this.window.document;

      // Append "-notification" to the ID to try to avoid ID conflicts with other stuff
      // in the document.
      const popupnotificationID = n.id + "-notification";

      // If the chrome document provides a popupnotification with this id, use
      // that. Otherwise create it ad-hoc.
      let popupnotification = doc.getElementById(popupnotificationID);
      if (popupnotification) {
        gNotificationParents.set(
          popupnotification,
          popupnotification.parentNode
        );
      } else {
        popupnotification = doc.createXULElement("popupnotification");
      }

      // Create the notification description element.
      const desc = this._formatDescriptionMessage(n);
      popupnotification.setAttribute("label", desc.start);
      popupnotification.setAttribute("name", desc.name);
      popupnotification.setAttribute("endlabel", desc.end);

      popupnotification.setAttribute("id", popupnotificationID);
      popupnotification.setAttribute("popupid", n.id);
      popupnotification.setAttribute(
        "oncommand",
        "PopupNotifications._onCommand(event);"
      );
      popupnotification.setAttribute(
        "closebuttoncommand",
        "PopupNotifications._dismiss(event);"
      );

      if (n.mainAction) {
        popupnotification.setAttribute("buttonlabel", n.mainAction.label);
        popupnotification.setAttribute(
          "buttonaccesskey",
          n.mainAction.accessKey
        );
        popupnotification.setAttribute(
          "buttonhighlight",
          !n.mainAction.disableHighlight
        );
        popupnotification.addEventListener("buttoncommand", PopupNotifications);
        popupnotification.setAttribute(
          "dropmarkerpopupshown",
          "PopupNotifications._onButtonEvent(event, 'dropmarkerpopupshown');"
        );
        popupnotification.addEventListener(
          "learnmoreclick",
          PopupNotifications
        );
        popupnotification.setAttribute(
          "menucommand",
          "PopupNotifications._onMenuCommand(event);"
        );
      } else {
        // Enable the default button to let the user close the popup if the close button is hidden
        popupnotification.addEventListener("buttoncommand", PopupNotifications);
        popupnotification.setAttribute("buttonhighlight", "true");
        popupnotification.removeAttribute("buttonlabel");
        popupnotification.removeAttribute("buttonaccesskey");
        popupnotification.removeAttribute("dropmarkerpopupshown");
        popupnotification.removeEventListener(
          "learnmoreclick",
          PopupNotifications
        );
        popupnotification.removeAttribute("menucommand");
      }

      if (n.options.popupIconClass) {
        const classes = "popup-notification-icon " + n.options.popupIconClass;
        popupnotification.setAttribute("iconclass", classes);
      }
      if (n.options.popupIconURL) {
        popupnotification.setAttribute("icon", n.options.popupIconURL);
      }

      if (n.options.learnMoreURL) {
        popupnotification.setAttribute("learnmoreurl", n.options.learnMoreURL);
      } else {
        popupnotification.removeAttribute("learnmoreurl");
      }

      if (n.options.displayURI) {
        let uri;
        try {
          if (n.options.displayURI instanceof Ci.nsIFileURL) {
            uri = n.options.displayURI.pathQueryRef;
          } else {
            try {
              uri = n.options.displayURI.hostPort;
            } catch (e) {
              uri = n.options.displayURI.spec;
            }
          }
          popupnotification.setAttribute("origin", uri);
        } catch (e) {
          console.error(e);
          popupnotification.removeAttribute("origin");
        }
      } else {
        popupnotification.removeAttribute("origin");
      }

      if (n.options.hideClose) {
        popupnotification.setAttribute("closebuttonhidden", "true");
      }

      popupnotification.notification = n;
      const menuitems = [];

      if (n.mainAction && n.secondaryActions && n.secondaryActions.length > 0) {
        const secondaryAction = n.secondaryActions[0];
        popupnotification.setAttribute(
          "secondarybuttonlabel",
          secondaryAction.label
        );
        popupnotification.setAttribute(
          "secondarybuttonaccesskey",
          secondaryAction.accessKey
        );
        popupnotification.addEventListener(
          "secondarybuttoncommand",
          PopupNotifications
        );
        popupnotification.removeAttribute("secondarybuttonhidden");

        for (let i = 1; i < n.secondaryActions.length; i++) {
          const action = n.secondaryActions[i];
          const item = doc.createXULElement("menuitem");
          item.setAttribute("label", action.label);
          item.setAttribute("accesskey", action.accessKey);
          item.notification = n;
          item.action = action;

          menuitems.push(item);
        }

        if (n.secondaryActions.length < 2) {
          popupnotification.setAttribute("dropmarkerhidden", "true");
        }
      } else {
        popupnotification.setAttribute("secondarybuttonhidden", "true");
        popupnotification.setAttribute("dropmarkerhidden", "true");
      }

      const checkbox = n.options.checkbox;
      if (checkbox && checkbox.label) {
        const checked =
          n._checkboxChecked != null ? n._checkboxChecked : !!checkbox.checked;

        popupnotification.checkboxState = {
          checked,
          label: checkbox.label,
        };

        if (checked) {
          this._setNotificationUIState(
            popupnotification,
            checkbox.checkedState
          );
        } else {
          this._setNotificationUIState(
            popupnotification,
            checkbox.uncheckedState
          );
        }
      } else {
        popupnotification.setAttribute("checkboxhidden", "true");
        popupnotification.setAttribute("warninghidden", "true");
      }

      this.panel.appendChild(popupnotification);

      // The popupnotification may be hidden if we got it from the chrome
      // document rather than creating it ad hoc.
      popupnotification.show();

      popupnotification.menupopup.textContent = "";
      popupnotification.menupopup.append(...menuitems);
    }, this);
  },

  _setNotificationUIState(notification, state = {}) {
    if (
      state.disableMainAction ||
      notification.hasAttribute("invalidselection")
    ) {
      notification.setAttribute("mainactiondisabled", "true");
    } else {
      notification.removeAttribute("mainactiondisabled");
    }
    if (state.warningLabel) {
      notification.setAttribute("warninglabel", state.warningLabel);
      notification.removeAttribute("warninghidden");
    } else {
      notification.setAttribute("warninghidden", "true");
    }
  },

  _showPanel(notificationsToShow, anchorElement) {
    this.panel.hidden = false;

    notificationsToShow = notificationsToShow.filter(n => {
      if (anchorElement != n.anchorElement) {
        return false;
      }

      const dismiss = this._fireCallback(n, NOTIFICATION_EVENT_SHOWING);
      if (dismiss) {
        n.dismissed = true;
      }
      return !dismiss;
    });
    if (!notificationsToShow.length) {
      return;
    }
    const notificationIds = notificationsToShow.map(n => n.id);

    this._refreshPanel(notificationsToShow);

    function isNullOrHidden(elem) {
      if (!elem) {
        return true;
      }

      const anchorRect = elem.getBoundingClientRect();
      return anchorRect.width == 0 && anchorRect.height == 0;
    }

    // If the anchor element is hidden or null, fall back to the identity icon.
    if (isNullOrHidden(anchorElement)) {
      anchorElement = this.window.document.getElementById("identity-icon");

      // If the identity icon is not available in this window, or maybe the
      // entire location bar is hidden for any reason, use the tab as the
      // anchor. We only ever show notifications for the current browser, so we
      // can just use the current tab.
      if (isNullOrHidden(anchorElement)) {
        anchorElement = this.tabbrowser.selectedTab;

        // If we're in an entirely chromeless environment, set the anchorElement
        // to null and let openPopup show the notification at (0,0) later.
        if (isNullOrHidden(anchorElement)) {
          anchorElement = null;
        }
      }
    }

    if (this.isPanelOpen && this._currentAnchorElement == anchorElement) {
      notificationsToShow.forEach(function (n) {
        this._fireCallback(n, NOTIFICATION_EVENT_SHOWN);
      }, this);

      // Make sure we update the noautohide attribute on the panel, in case it changed.
      if (notificationsToShow.some(n => n.options.persistent)) {
        this.panel.setAttribute("noautohide", "true");
      } else {
        this.panel.removeAttribute("noautohide");
      }

      // Let tests know that the panel was updated and what notifications it was
      // updated with so that tests can wait for the correct notifications to be
      // added.
      const event = new this.window.CustomEvent("PanelUpdated", {
        detail: notificationIds,
      });
      this.panel.dispatchEvent(event);
      return;
    }

    // If the panel is already open but we're changing anchors, we need to hide
    // it first.  Otherwise it can appear in the wrong spot.  (_hidePanel is
    // safe to call even if the panel is already hidden.)
    this._hidePanel().then(() => {
      this._currentAnchorElement = anchorElement;

      if (notificationsToShow.some(n => n.options.persistent)) {
        this.panel.setAttribute("noautohide", "true");
      } else {
        this.panel.removeAttribute("noautohide");
      }

      notificationsToShow.forEach(function (n) {
        // Record that the notification was actually displayed on screen.
        // Notifications that were opened a second time or that were originally
        // shown with "options.dismissed" will be recorded in a separate bucket.
        // Remember the time the notification was shown for the security delay.
        n.timeShown = this.window.performance.now();
      }, this);

      let target = this.panel;
      if (target.parentNode) {
        // NOTIFICATION_EVENT_SHOWN should be fired for the panel before
        // anyone listening for popupshown on the panel gets run. Otherwise,
        // the panel will not be initialized when the popupshown event
        // listeners run.
        // By targeting the panel's parent and using a capturing listener, we
        // can have our listener called before others waiting for the panel to
        // be shown (which probably expect the panel to be fully initialized)
        target = target.parentNode;
      }
      if (this._popupshownListener) {
        target.removeEventListener(
          "popupshown",
          this._popupshownListener,
          true
        );
      }
      this._popupshownListener = function () {
        target.removeEventListener(
          "popupshown",
          this._popupshownListener,
          true
        );
        this._popupshownListener = null;

        notificationsToShow.forEach(function (n) {
          this._fireCallback(n, NOTIFICATION_EVENT_SHOWN);
        }, this);
        // These notifications are used by tests to know when all the processing
        // required to display the panel has happened.
        this.panel.dispatchEvent(new this.window.CustomEvent("Shown"));
        const event = new this.window.CustomEvent("PanelUpdated", {
          detail: notificationIds,
        });
        this.panel.dispatchEvent(event);
      };
      this._popupshownListener = this._popupshownListener.bind(this);
      target.addEventListener("popupshown", this._popupshownListener, true);

      this.panel.openPopup(anchorElement, "after_end", 0, 0, true);
    });
  },

  /**
   * Updates the notification state in response to window activation or tab
   * selection changes.
   *
   * @param {?Notification[]} notifications - An array of Notification instances.
   *   If null, notifications will be retrieved off the current browser tab.
   * @param {Element|Set<Element>} anchors - Is a XUL element or a Set of XUL
   *   elements that the notifications panel(s) will be anchored to.
   * @param {boolean} dismissShowing - If true, dismiss any currently visible
   *   notifications if there are no notifications to show. Otherwise,
   *   currently displayed notifications will be left alone.
   */
  _update(notifications, anchors = new Set(), dismissShowing = false) {
    if (ChromeUtils.getClassName(anchors) == "XULElement") {
      anchors = new Set([anchors]);
    }

    if (!notifications) {
      notifications = this._currentNotifications;
    }

    const haveNotifications = notifications.length > 0;
    if (!anchors.size && haveNotifications) {
      anchors = this._getAnchorsForNotifications(notifications);
    }

    let useIconBox = !!this.iconBox;
    if (useIconBox && anchors.size) {
      for (const anchor of anchors) {
        if (anchor.parentNode == this.iconBox) {
          continue;
        }
        useIconBox = false;
        break;
      }
    }

    // Filter out notifications that have been dismissed, unless they are
    // persistent. Also check if we should not show any notification.
    let notificationsToShow = [];
    if (!this._suppress) {
      notificationsToShow = notifications.filter(
        n => (!n.dismissed || n.options.persistent) && !n.options.neverShow
      );
    }

    if (useIconBox) {
      // Hide icons of the previous tab.
      this._hideIcons();
    }

    if (haveNotifications) {
      // Also filter out notifications that are for a different anchor.
      notificationsToShow = notificationsToShow.filter(function (n) {
        return anchors.has(n.anchorElement);
      });

      if (useIconBox) {
        this._showIcons(notifications);
        this.iconBox.hidden = false;
        // Make sure that panels can only be attached to anchors of shown
        // notifications inside an iconBox.
        anchors = this._getAnchorsForNotifications(notificationsToShow);
      } else if (anchors.size) {
        this._updateAnchorIcons(notifications, anchors);
      }
    }

    if (notificationsToShow.length > 0) {
      const anchorElement = anchors.values().next().value;
      if (anchorElement) {
        this._showPanel(notificationsToShow, anchorElement);
      }

      // Setup a capturing event listener on the whole window to catch the
      // escape key while persistent notifications are visible.
      this.window.addEventListener(
        "keypress",
        this._handleWindowKeyPress,
        true
      );
    } else {
      // Notify observers that we're not showing the popup (useful for testing)
      this._notify("updateNotShowing");

      // Close the panel if there are no notifications to show.
      // When called from PopupNotifications.show() we should never close the
      // panel, however. It may just be adding a dismissed notification, in
      // which case we want to continue showing any existing notifications.
      if (!dismissShowing) {
        this._dismiss();
      }

      // Only hide the iconBox if we actually have no notifications (as opposed
      // to not having any showable notifications)
      if (!haveNotifications) {
        if (useIconBox) {
          this.iconBox.hidden = true;
        } else if (anchors.size) {
          for (const anchorElement of anchors) {
            anchorElement.removeAttribute(ICON_ATTRIBUTE_SHOWING);
          }
        }
      }

      // Stop listening to keyboard events for notifications.
      this.window.removeEventListener(
        "keypress",
        this._handleWindowKeyPress,
        true
      );
    }
  },

  _updateAnchorIcons(notifications, anchorElements) {
    for (const anchorElement of anchorElements) {
      anchorElement.setAttribute(ICON_ATTRIBUTE_SHOWING, "true");
      // Use the anchorID as a class along with the default icon class as a
      // fallback if anchorID is not defined in CSS. We always use the first
      // notifications icon, so in the case of multiple notifications we'll
      // only use the default icon.
      if (anchorElement.classList.contains("notification-anchor-icon")) {
        // remove previous icon classes
        let className = anchorElement.className.replace(
          /([-\w]+-notification-icon\s?)/g,
          ""
        );
        if (notifications.length > 0) {
          // Find the first notification this anchor used for.
          let notification = notifications[0];
          for (const n of notifications) {
            if (n.anchorElement == anchorElement) {
              notification = n;
              break;
            }
          }
          // With this notification we can better approximate the most fitting
          // style.
          className = notification.anchorID + " " + className;
        }
        anchorElement.className = className;
      }
    }
  },

  _showIcons(aCurrentNotifications) {
    for (const notification of aCurrentNotifications) {
      const anchorElm = notification.anchorElement;
      if (anchorElm) {
        anchorElm.setAttribute(ICON_ATTRIBUTE_SHOWING, "true");

        if (notification.options.extraAttr) {
          anchorElm.setAttribute("extraAttr", notification.options.extraAttr);
        }
      }
    }
  },

  _hideIcons() {
    const icons = this.iconBox.querySelectorAll(ICON_SELECTOR);
    for (const icon of icons) {
      icon.removeAttribute(ICON_ATTRIBUTE_SHOWING);
    }
  },

  _getNotificationsForBrowser() {
    return popupNotificationsMap;
  },
  _setNotificationsForBrowser(browser, notifications) {
    popupNotificationsMap = notifications;
    return notifications;
  },

  _getAnchorsForNotifications(notifications, defaultAnchor) {
    const anchors = new Set();
    for (const notification of notifications) {
      if (notification.anchorElement) {
        anchors.add(notification.anchorElement);
      }
    }
    if (defaultAnchor && !anchors.size) {
      anchors.add(defaultAnchor);
    }
    return anchors;
  },

  _onIconBoxCommand(event) {
    // Left click, space or enter only
    const type = event.type;
    if (type == "click" && event.button != 0) {
      return;
    }

    if (
      type == "keypress" &&
      !(
        event.charCode == event.DOM_VK_SPACE ||
        event.keyCode == event.DOM_VK_RETURN
      )
    ) {
      return;
    }

    if (this._currentNotifications.length == 0) {
      return;
    }

    event.stopPropagation();

    // Get the anchor that is the immediate child of the icon box
    let anchor = event.target;
    while (anchor && anchor.parentNode != this.iconBox) {
      anchor = anchor.parentNode;
    }

    if (!anchor) {
      return;
    }

    // If the panel is not closed, and the anchor is different, immediately mark all
    // active notifications for the previous anchor as dismissed
    if (this.panel.state != "closed" && anchor != this._currentAnchorElement) {
      this._dismissOrRemoveCurrentNotifications();
    }

    // Avoid reshowing notifications that are already shown and have not been dismissed.
    if (this.panel.state == "closed" || anchor != this._currentAnchorElement) {
      // As soon as the panel is shown, focus the first element in the selected notification.
      this.panel.addEventListener(
        "popupshown",
        () =>
          this.window.document.commandDispatcher.advanceFocusIntoSubtree(
            this.panel
          ),
        { once: true }
      );

      this._reshowNotifications(anchor);
    } else {
      // Focus the first element in the selected notification.
      this.window.document.commandDispatcher.advanceFocusIntoSubtree(
        this.panel
      );
    }
  },

  _reshowNotifications(anchor, browser) {
    // Mark notifications anchored to this anchor as un-dismissed
    browser = browser || this.tabbrowser.selectedBrowser;
    const notifications = this._getNotificationsForBrowser(browser);
    notifications.forEach(function (n) {
      if (n.anchorElement == anchor) {
        n.dismissed = false;
      }
    });

    // ...and then show them.
    this._update(notifications, anchor);
  },

  _swapBrowserNotifications(ourBrowser, otherBrowser) {
    // When swapping browser docshells (e.g. dragging tab to new window) we need
    // to update our notification map.

    let ourNotifications = this._getNotificationsForBrowser(ourBrowser);
    const other = otherBrowser.ownerGlobal.PopupNotifications;
    if (!other) {
      if (ourNotifications.length > 0) {
        console.error(
          "unable to swap notifications: otherBrowser doesn't support notifications"
        );
      }
      return;
    }
    let otherNotifications = other._getNotificationsForBrowser(otherBrowser);
    if (ourNotifications.length < 1 && otherNotifications.length < 1) {
      // No notification to swap.
      return;
    }

    otherNotifications = otherNotifications.filter(n => {
      if (this._fireCallback(n, NOTIFICATION_EVENT_SWAPPING, ourBrowser)) {
        n.browser = ourBrowser;
        n.owner = this;
        return true;
      }
      other._fireCallback(n, NOTIFICATION_EVENT_REMOVED);
      return false;
    });

    ourNotifications = ourNotifications.filter(n => {
      if (this._fireCallback(n, NOTIFICATION_EVENT_SWAPPING, otherBrowser)) {
        n.browser = otherBrowser;
        n.owner = other;
        return true;
      }
      this._fireCallback(n, NOTIFICATION_EVENT_REMOVED);
      return false;
    });

    this._setNotificationsForBrowser(otherBrowser, ourNotifications);
    other._setNotificationsForBrowser(ourBrowser, otherNotifications);

    if (otherNotifications.length > 0) {
      this._update(otherNotifications);
    }
    if (ourNotifications.length > 0) {
      other._update(ourNotifications);
    }
  },

  _fireCallback(n, event, ...args) {
    try {
      if (n.options.eventCallback) {
        return n.options.eventCallback.call(n, event, ...args);
      }
    } catch (error) {
      console.error(error);
    }
    return undefined;
  },

  _onPopupHidden(event) {
    if (event.target != this.panel) {
      return;
    }

    // We may have removed the "noautofocus" attribute before showing the panel
    // if the notification specified it wants to autofocus on first show.
    // When the panel is closed, we have to restore the attribute to its default
    // value, so we don't autofocus it if it's subsequently opened from a different code path.
    this.panel.setAttribute("noautofocus", "true");

    // Handle the case where the panel was closed programmatically.
    if (this._ignoreDismissal) {
      this._ignoreDismissal.resolve();
      this._ignoreDismissal = null;
      return;
    }

    this._dismissOrRemoveCurrentNotifications();

    this._clearPanel();

    this._update();
  },

  _dismissOrRemoveCurrentNotifications() {
    const browser =
      this.panel.firstElementChild &&
      this.panel.firstElementChild.notification.browser;
    if (!browser) {
      return;
    }

    const notifications = this._getNotificationsForBrowser(browser);
    // Mark notifications as dismissed and call dismissal callbacks
    for (const nEl of this.panel.children) {
      const notificationObj = nEl.notification;
      // Never call a dismissal handler on a notification that's been removed.
      if (!notifications.includes(notificationObj)) {
        return;
      }

      // Do not mark the notification as dismissed or fire NOTIFICATION_EVENT_DISMISSED
      // if the notification is removed.
      if (notificationObj.options.removeOnDismissal) {
        this._remove(notificationObj);
      } else {
        notificationObj.dismissed = true;
        this._fireCallback(notificationObj, NOTIFICATION_EVENT_DISMISSED);
      }
    }
  },

  _onCheckboxCommand(event) {
    const notificationEl = getNotificationFromElement(event.target);
    const checked = notificationEl.checkbox.checked;
    const notification = notificationEl.notification;

    // Save checkbox state to be able to persist it when re-opening the doorhanger.
    notification._checkboxChecked = checked;

    if (checked) {
      this._setNotificationUIState(
        notificationEl,
        notification.options.checkbox.checkedState
      );
    } else {
      this._setNotificationUIState(
        notificationEl,
        notification.options.checkbox.uncheckedState
      );
    }
    event.stopPropagation();
  },

  _onCommand(event) {
    // Ignore events from buttons as they are submitting and so don't need checks
    if (event.target.localName == "button") {
      return;
    }
    const notificationEl = getNotificationFromElement(event.target);
    this._setNotificationUIState(notificationEl);
  },

  _onButtonEvent(event, type, source = "button", notificationEl = null) {
    if (!notificationEl) {
      notificationEl = getNotificationFromElement(event.target);
    }

    if (!notificationEl) {
      throw new Error(
        "PopupNotifications._onButtonEvent: couldn't find notification element"
      );
    }

    if (!notificationEl.notification) {
      throw new Error(
        "PopupNotifications._onButtonEvent: couldn't find notification"
      );
    }

    const notification = notificationEl.notification;

    if (type == "dropmarkerpopupshown") {
      return;
    }

    if (type == "learnmoreclick") {
      return;
    }

    if (type == "buttoncommand" || type == "secondarybuttoncommand") {
      if (Services.focus.activeWindow != this.window) {
        Services.console.logStringMessage(
          "PopupNotifications._onButtonEvent: " +
            "Button click happened before the window was focused"
        );
        this.window.focus();
        return;
      }

      const timeSinceShown =
        this.window.performance.now() - notification.timeShown;
      if (timeSinceShown < this.buttonDelay) {
        Services.console.logStringMessage(
          "PopupNotifications._onButtonEvent: " +
            "Button click happened before the security delay: " +
            timeSinceShown +
            "ms"
        );
        return;
      }
    }

    let action = notification.mainAction;
    if (type == "secondarybuttoncommand") {
      action = notification.secondaryActions[0];
    }

    if (action) {
      try {
        action.callback.call(undefined, {
          checkboxChecked: notificationEl.checkbox.checked,
          source,
        });
      } catch (error) {
        console.error(error);
      }

      if (action.dismiss) {
        this._dismiss();
        return;
      }
    }

    this._remove(notification);
    this._update();
  },

  _onMenuCommand(event) {
    const target = event.target;
    if (!target.action || !target.notification) {
      throw new Error(
        "menucommand target has no associated action/notification"
      );
    }

    const notificationEl = getNotificationFromElement(target);
    event.stopPropagation();

    try {
      target.action.callback.call(undefined, {
        checkboxChecked: notificationEl.checkbox.checked,
        source: "menucommand",
      });
    } catch (error) {
      console.error(error);
    }

    if (target.action.dismiss) {
      this._dismiss();
      return;
    }

    this._remove(target.notification);
    this._update();
  },

  _notify(topic) {
    Services.obs.notifyObservers(null, "PopupNotifications-" + topic);
  },
};
