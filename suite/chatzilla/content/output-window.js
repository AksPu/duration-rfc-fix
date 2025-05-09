/* -*- Mode: C++; tab-width: 4; indent-tabs-mode: nil; c-basic-offset: 4 -*-
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

var initialized = false;

var view;
var client;
var mainWindow;
var clickHandler;

var dd;
var getMsg;
var getObjectDetails;

var header = null;
var headers = {
  IRCClient: {
    prefix: "cli-",
    fields: [
      "container",
      "netcount",
      "version-container",
      "version",
      "connectcount",
    ],
    update: updateClient,
  },

  IRCNetwork: {
    prefix: "net-",
    fields: ["container", "url-anchor", "status", "lag"],
    update: updateNetwork,
  },

  IRCChannel: {
    prefix: "ch-",
    fields: [
      "container",
      "url-anchor",
      "modestr",
      "usercount",
      "topicnodes",
      "topicinput",
      "topiccancel",
    ],
    update: updateChannel,
  },

  IRCUser: {
    prefix: "usr-",
    fields: ["container", "url-anchor", "serverstr", "title", "descnodes"],
    update: updateUser,
  },

  IRCDCCChat: {
    prefix: "dcc-chat-",
    fields: ["container", "remotestr", "title"],
    update: updateDCCChat,
  },

  IRCDCCFileTransfer: {
    prefix: "dcc-file-",
    fields: ["container", "file", "progress", "progressbar"],
    update: updateDCCFile,
  },
};

var initOutputWindow = stock_initOutputWindow;

function stock_initOutputWindow(newClient, newView, newClickHandler) {
  function initHeader() {
    /* it's better if we wait a half a second before poking at these
     * dom nodes. */
    setHeaderState(view.prefs.displayHeader);
    updateHeader();
    var div = document.getElementById("messages-outer");
    div.removeAttribute("hidden");
    window.scrollTo(0, window.document.body.clientHeight);
  }

  client = newClient;
  view = newView;
  clickHandler = newClickHandler;
  mainWindow = client.mainWindow;

  client.messageManager.importBundle(client.defaultBundle, window);

  getMsg = mainWindow.getMsg;
  getObjectDetails = mainWindow.getObjectDetails;
  dd = mainWindow.dd;

  changeCSS(view.prefs["motif.current"]);
  updateMotifSettings();

  var output = document.getElementById("output");
  output.appendChild(adoptNode(view.messages));

  if (view.TYPE in headers) {
    header = cacheNodes(headers[view.TYPE].prefix, headers[view.TYPE].fields);
    // Turn off accessibility announcements: they're useless as all these
    // changes are in the "log" as well, normally.
    // We're setting the attribute here instead of in the HTML to cope with
    // custom output windows and so we set it only on the Right header
    // for this view.
    header.container.setAttribute("aria-live", "off");
    header.update = headers[view.TYPE].update;
  }

  var name;
  if ("unicodeName" in view) {
    name = view.unicodeName;
  } else {
    name = view.name;
  }
  updateSplash(name);

  setTimeout(initHeader, 500);

  initialized = true;
}

function onTopicNodesClick(e) {
  if (!clickHandler(e)) {
    if (e.which != 1) {
      return;
    }

    startTopicEdit();
  }

  e.stopPropagation();
}

function onTopicKeypress(e) {
  switch (e.keyCode) {
    case 13 /* enter */:
      var topic = header.topicinput.value;
      topic = mainWindow.replaceColorCodes(topic);
      view.setTopic(topic);
      cancelTopicEdit(true);
      view.dispatch("focus-input");
      break;

    case 27 /* esc */:
      cancelTopicEdit(true);
      view.dispatch("focus-input");
      break;

    default:
      client.mainWindow.onInputKeyPress(e);
  }
}

function startTopicEdit() {
  var me = view.getUser(view.parent.me.unicodeName);
  if (
    !me ||
    (!view.mode.publicTopic && !me.isOp && !me.isHalfOp) ||
    !hasAttribute("topicinput", "hidden")
  ) {
    return;
  }

  header.topicinput.value = mainWindow.decodeColorCodes(view.topic);

  header.topicnodes.setAttribute("hidden", "true");
  header.topicinput.removeAttribute("hidden");
  header.topiccancel.removeAttribute("hidden");
  header.topicinput.focus();
  header.topicinput.selectionStart = 0;
}

function cancelTopicEdit(force) {
  var originalTopic = mainWindow.decodeColorCodes(view.topic);
  if (
    !hasAttribute("topicnodes", "hidden") ||
    (!force && header.topicinput.value != originalTopic)
  ) {
    return;
  }

  header.topicinput.setAttribute("hidden", "true");
  header.topiccancel.setAttribute("hidden", "true");
  header.topicnodes.removeAttribute("hidden");
}

function cacheNodes(pfx, ary, nodes) {
  if (!nodes) {
    nodes = {};
  }

  for (var i = 0; i < ary.length; ++i) {
    nodes[ary[i]] = document.getElementById(pfx + ary[i]);
  }

  return nodes;
}

function changeCSS(url, id) {
  if (!id) {
    id = "main-css";
  }

  var node = document.getElementById(id);

  if (!node) {
    node = document.createElement("link");
    node.setAttribute("id", id);
    node.setAttribute("rel", "stylesheet");
    node.setAttribute("type", "text/css");
    var head = document.getElementsByTagName("head")[0];
    head.appendChild(node);
  } else if (node.getAttribute("href") == url) {
    return;
  }

  node.setAttribute("href", url);
  window.scrollTo(0, window.document.body.clientHeight);
}

function scrollToElement(element, position) {
  /* The following values can be used for element:
   *   selection       - current selected text.
   *   marker          - the activity marker.
   *   [any DOM node]  - anything :)
   *
   * The following values can be used for position:
   *   top             - scroll so it is at the top.
   *   center          - scroll so it is in the middle.
   *   bottom          - scroll so it is at the bottom.
   *   inview          - scroll so it is in view.
   */
  switch (element) {
    case "selection":
      var sel = window.getSelection();
      if (sel) {
        element = sel.anchorNode;
      } else {
        element = null;
      }
      break;

    case "marker":
      if ("getActivityMarker" in view) {
        element = view.getActivityMarker();
      } else {
        element = null;
      }
      break;
  }
  if (!element) {
    return;
  }

  // Calculate element's position in document.
  var pos = { top: 0, center: 0, bottom: 0 };
  // Find first parent with offset data.
  while (element && !("offsetParent" in element)) {
    element = element.parentNode;
  }
  var elt = element;
  // Calc total offset data.
  while (elt) {
    pos.top += 0 + elt.offsetTop;
    elt = elt.offsetParent;
  }
  pos.center = pos.top + element.offsetHeight / 2;
  pos.bottom = pos.top + element.offsetHeight;

  // Store the positions to align the element with.
  var cont = {
    top: 0,
    center: window.innerHeight / 2,
    bottom: window.innerHeight,
  };
  if (!hasAttribute("container", "hidden")) {
    /* Offset height doesn't include the margins, so we get to do that
     * ourselves via getComputedStyle(). We're assuming that will return
     * a px value, which is all but guaranteed.
     */
    var headerHeight = header.container.offsetHeight;
    var css = getComputedStyle(header.container, null);
    headerHeight += parseInt(css.marginTop) + parseInt(css.marginBottom);
    cont.top += headerHeight;
    cont.center += headerHeight / 2;
  }

  // Pick between 'top' and 'bottom' for 'inview' position.
  if (position == "inview") {
    if (pos.top - window.scrollY < cont.top) {
      position = "top";
    } else if (pos.bottom - window.scrollY > cont.bottom) {
      position = "bottom";
    } else {
      return;
    }
  }

  window.scrollTo(0, pos[position] - cont[position]);
}

function updateMotifSettings(existingTimeout) {
  // Try... catch with a repeat to cope with the style sheet not being loaded
  const TIMEOUT = 100;
  try {
    existingTimeout += TIMEOUT;
    view.motifSettings = getMotifSettings();
  } catch (ex) {
    if (existingTimeout >= 30000) {
      // Stop after trying for 30 seconds
      return;
    }
    if (ex.name == "NS_ERROR_DOM_INVALID_ACCESS_ERR") {
      //not ready, try again
      setTimeout(updateMotifSettings, TIMEOUT, existingTimeout);
    } // something else, panic!
    else {
      dd(ex);
    }
  }
}

function getMotifSettings() {
  var re = new RegExp("czsettings\\.(\\w*)", "i");
  var rules = document.getElementById("main-css").sheet.cssRules;
  var rv = {};
  var ary;
  // Copy any settings, which are available in the motif using the
  // "CZSETTINGS" selector. We only store the regexp match after checking
  // the rule type because selectorText is not defined on other rule types.
  for (var i = 0; i < rules.length; i++) {
    if (
      rules[i].type == CSSRule.STYLE_RULE &&
      (ary = rules[i].selectorText.match(re)) != null
    ) {
      rv[ary[1]] = true;
    }
  }
  return rv;
}

function adoptNode(node) {
  return client.adoptNode(node, document);
}

function setText(field, text, checkCondition) {
  if (!header[field].firstChild) {
    header[field].appendChild(document.createTextNode(""));
  }

  if (typeof text != "string") {
    text = MSG_UNKNOWN;
    if (checkCondition) {
      setAttribute(field, "condition", "red");
    }
  } else if (checkCondition) {
    setAttribute(field, "condition", "green");
  }

  header[field].firstChild.data = text;
}

function setAttribute(field, name, value) {
  if (!value) {
    value = "true";
  }

  header[field].setAttribute(name, value);
}

function removeAttribute(field, name) {
  header[field].removeAttribute(name);
}

function hasAttribute(field, name) {
  return header[field].hasAttribute(name);
}

function setHeaderState(state) {
  if (header) {
    if (state) {
      removeAttribute("container", "hidden");
      updateHeader();
    } else {
      setAttribute("container", "hidden");
    }
  }
}

function updateHeader() {
  document.title = view.getURL();

  if (!header || hasAttribute("container", "hidden")) {
    return;
  }

  for (var id in header) {
    var value;

    if (id == "url-anchor") {
      value = view.getURL();
      setAttribute("url-anchor", "href", value);
      setText("url-anchor", value);
    } else if (id in view) {
      setText(id, view[id]);
    }
  }

  if (header.update) {
    header.update();
  }
}

function updateClient() {
  var n = 0,
    c = 0;
  for (name in client.networks) {
    ++n;
    if (client.networks[name].isConnected()) {
      ++c;
    }
  }

  setAttribute("version-container", "title", client.userAgent);
  setText("version", client.version);
  setText("netcount", String(n));
  setText("connectcount", String(c));
}

function updateNetwork() {
  if (view.state == mainWindow.NET_CONNECTING) {
    setText("status", MSG_CONNECTING);
    setAttribute("status", "condition", "yellow");
    removeAttribute("status", "title");
    setText("lag", MSG_UNKNOWN);
  } else if (view.isConnected()) {
    setText("status", MSG_CONNECTED);
    setAttribute("status", "condition", "green");
    setAttribute(
      "status",
      "title",
      getMsg(MSG_CONNECT_VIA, view.primServ.unicodeName)
    );
    var lag = view.primServ.lag;
    if (lag != -1) {
      setText("lag", getMsg(MSG_FMT_SECONDS, lag.toFixed(2)));
    } else {
      setText("lag", MSG_UNKNOWN);
    }
  } else {
    setText("status", MSG_DISCONNECTED);
    setAttribute("status", "condition", "red");
    removeAttribute("status", "title");
    setText("lag", MSG_UNKNOWN);
  }
}

function updateChannel() {
  if (header.topicnodes.firstChild) {
    header.topicnodes.firstChild.remove();
  }

  if (view.active) {
    var str = view.mode.getModeStr();
    if (!str) {
      str = MSG_NO_MODE;
    }
    setText("modestr", str);
    setAttribute("modestr", "condition", "green");

    setText(
      "usercount",
      getMsg(MSG_FMT_USERCOUNT, [
        view.getUsersLength(),
        view.opCount,
        view.halfopCount,
        view.voiceCount,
      ])
    );
    setAttribute("usercount", "condition", "green");

    if (view.topic) {
      var data = getObjectDetails(view);
      data.dontLogURLs = true;
      var mailto = client.prefs["munger.mailto"];
      client.munger.getRule(".mailto").enabled = mailto;
      var nodes = client.munger.munge(view.topic, null, data);
      client.munger.getRule(".mailto").enabled = false;
      header.topicnodes.appendChild(adoptNode(nodes));
    } else {
      setText("topicnodes", MSG_NONE);
    }
  } else {
    setText("modestr", MSG_UNKNOWN);
    setAttribute("modestr", "condition", "red");
    setText("usercount", MSG_UNKNOWN);
    setAttribute("usercount", "condition", "red");
    setText("topicnodes", MSG_UNKNOWN);
  }
}

function updateUser() {
  var source;
  if (view.name) {
    source = "<" + view.name + "@" + view.host + ">";
  } else {
    source = MSG_UNKNOWN;
  }

  if (view.parent.isConnected) {
    setText("serverstr", view.connectionHost, true);
  } else {
    setText("serverstr", null, true);
  }

  setText("title", getMsg(MSG_TITLE_USER, [view.unicodeName, source]));

  if (header.descnodes.firstChild) {
    header.descnodes.firstChild.remove();
  }

  if (typeof view.desc != "undefined") {
    var data = getObjectDetails(view);
    data.dontLogURLs = true;
    var nodes = client.munger.munge(view.desc, null, data);
    header.descnodes.appendChild(adoptNode(nodes));
  } else {
    setText("descnodes", "");
  }
}

function updateDCCChat() {
  if (view.state.state == 4) {
    setText("remotestr", view.remoteIP + ":" + view.port, true);
  } else {
    setText("remotestr", null, true);
  }

  setText("title", getMsg(MSG_TITLE_DCCCHAT, view.user.unicodeName));
}

function updateDCCFile() {
  var pcent = view.progress;

  setText("file", view.filename);
  setText(
    "progress",
    getMsg(MSG_DCCFILE_PROGRESS, [
      pcent,
      mainWindow.getSISize(view.position),
      mainWindow.getSISize(view.size),
      mainWindow.getSISpeed(view.speed),
    ])
  );

  setAttribute("progressbar", "width", pcent + "%");
}

function updateSplash(content) {
  var splash = document.getElementById("splash");
  splash.appendChild(document.createTextNode(content));
}
