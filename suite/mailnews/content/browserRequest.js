/* -*- indent-tabs-mode: nil; js-indent-level: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const wpl = Ci.nsIWebProgressListener;

var reporterListener = {
  _isBusy: false,
  get securityButton() {
    delete this.securityButton;
    return this.securityButton = document.getElementById("security-button");
  },

  QueryInterface: ChromeUtils.generateQI([Ci.nsIWebProgressListener,
                                          Ci.nsISupportsWeakReference]),

  onStateChange: function(/*in nsIWebProgress*/ aWebProgress,
                     /*in nsIRequest*/ aRequest,
                     /*in unsigned long*/ aStateFlags,
                     /*in nsresult*/ aStatus) {
  },

  onProgressChange: function(/*in nsIWebProgress*/ aWebProgress,
                        /*in nsIRequest*/ aRequest,
                        /*in long*/ aCurSelfProgress,
                        /*in long */aMaxSelfProgress,
                        /*in long */aCurTotalProgress,
                        /*in long */aMaxTotalProgress) {
  },

  onLocationChange: function(/*in nsIWebProgress*/ aWebProgress,
                        /*in nsIRequest*/ aRequest,
                        /*in nsIURI*/ aLocation) {
    document.getElementById("headerMessage").textContent = aLocation.spec;
  },

  onStatusChange: function(/*in nsIWebProgress*/ aWebProgress,
                      /*in nsIRequest*/ aRequest,
                      /*in nsresult*/ aStatus,
                      /*in wstring*/ aMessage) {
  },

  onSecurityChange: function(/*in nsIWebProgress*/ aWebProgress,
                        /*in nsIRequest*/ aRequest,
                        /*in unsigned long*/ aState) {
    const wpl_security_bits = wpl.STATE_IS_SECURE |
                              wpl.STATE_IS_BROKEN |
                              wpl.STATE_IS_INSECURE;
    var browser = document.getElementById("requestFrame");
    var level;

    switch (aState & wpl_security_bits) {
      case wpl.STATE_IS_SECURE:
        level = "high";
        break;
      case wpl.STATE_IS_BROKEN:
        level = "broken";
        break;
    }
    if (level) {
      this.securityButton.setAttribute("level", level);
      this.securityButton.hidden = false;
    } else {
      this.securityButton.hidden = true;
      this.securityButton.removeAttribute("level");
    }
    this.securityButton.setAttribute("tooltiptext",
                                     browser.securityUI.tooltipText);
  }
}

function cancelRequest()
{
  reportUserClosed();
  window.close();
}

function reportUserClosed()
{
  let request = window.arguments[0].wrappedJSObject;
  request.cancelled();
}

function loadRequestedUrl()
{
  let request = window.arguments[0].wrappedJSObject;
  document.getElementById("headerMessage").textContent = request.promptText;
  let account = request.account;
  if (request.iconURI != "")
    document.getElementById("headerImage").src = request.iconURI;

  var browser = document.getElementById("requestFrame");
  browser.addProgressListener(reporterListener,
                              Ci.nsIWebProgress.NOTIFY_ALL);
  var url = request.url;
  if (url != "") {
    browser.setAttribute("src", url);
    document.getElementById("headerMessage").textContent = url;
  }
  request.loaded(window, browser.webProgress);
}
