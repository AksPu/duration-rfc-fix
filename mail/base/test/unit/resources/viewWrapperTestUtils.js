/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

var { DBViewWrapper, IDBViewWrapperListener } = ChromeUtils.importESModule(
  "resource:///modules/DBViewWrapper.sys.mjs"
);
var { MailViewManager, MailViewConstants } = ChromeUtils.importESModule(
  "resource:///modules/MailViewManager.sys.mjs"
);
var { VirtualFolderHelper } = ChromeUtils.importESModule(
  "resource:///modules/VirtualFolderWrapper.sys.mjs"
);
var { MessageGenerator, MessageScenarioFactory } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/MessageGenerator.sys.mjs"
);
var { MessageInjection } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/MessageInjection.sys.mjs"
);
var { dump_view_state } = ChromeUtils.importESModule(
  "resource://testing-common/mail/ViewHelpers.sys.mjs"
);

var gMessageGenerator;
var gMessageScenarioFactory;
var messageInjection;
var gMockViewWrapperListener;

function initViewWrapperTestUtils(aInjectionConfig) {
  if (!aInjectionConfig) {
    throw new Error("Please provide an injection config for MessageInjection.");
  }

  gMessageGenerator = new MessageGenerator();
  gMessageScenarioFactory = new MessageScenarioFactory(gMessageGenerator);

  messageInjection = new MessageInjection(aInjectionConfig, gMessageGenerator);
  messageInjection.registerMessageInjectionListener(VWTU_testHelper);
  registerCleanupFunction(() => {
    // Cleanup of VWTU_testHelper.
    VWTU_testHelper.postTest();
  });
  gMockViewWrapperListener = new MockViewWrapperListener();
}

// Something less sucky than do_check_true.
function assert_true(aBeTrue, aWhy, aDumpView) {
  if (!aBeTrue) {
    if (aDumpView) {
      dump_view_state(VWTU_testHelper.active_view_wrappers[0]);
    }
    do_throw(aWhy);
  }
}

function assert_false(aBeFalse, aWhy, aDumpView) {
  if (aBeFalse) {
    if (aDumpView) {
      dump_view_state(VWTU_testHelper.active_view_wrappers[0]);
    }
    do_throw(aWhy);
  }
}

function assert_equals(aA, aB, aWhy, aDumpView) {
  if (aA != aB) {
    if (aDumpView) {
      dump_view_state(VWTU_testHelper.active_view_wrappers[0]);
    }
    do_throw(aWhy);
  }
}

function assert_bit_set(aWhat, aBit, aWhy) {
  if (!(aWhat & aBit)) {
    do_throw(aWhy);
  }
}

function assert_bit_not_set(aWhat, aBit, aWhy) {
  if (aWhat & aBit) {
    do_throw(aWhy);
  }
}

var gFakeCommandUpdater = {
  QueryInterface: ChromeUtils.generateQI(["nsIMsgDBViewCommandUpdater"]),
  updateNextMessageAfterDelete() {},
  selectedMessageRemoved() {},
};

/**
 * Track our resources used by each test.  This is so we can keep our memory
 *  usage low by forcing things to be forgotten about (or even nuked) once
 *  a test completes, but also so we can provide useful information about the
 *  state of things if a test times out.
 */
var VWTU_testHelper = {
  active_view_wrappers: [],
  active_real_folders: [],
  active_virtual_folders: [],

  onVirtualFolderCreated(aVirtualFolder) {
    this.active_virtual_folders.push(aVirtualFolder);
  },

  postTest() {
    // Close all the views we opened.
    this.active_view_wrappers.forEach(function (wrapper) {
      wrapper.close();
    });
    // Verify that the notification helper has no outstanding listeners.
    if (IDBViewWrapperListener.prototype._FNH.haveListeners()) {
      const msg = "FolderNotificationHelper has listeners, but should not.";
      dump("*** " + msg + "\n");
      dump("Pending URIs:\n");
      for (const folderURI in IDBViewWrapperListener.prototype._FNH
        ._pendingFolderUriToViewWrapperLists) {
        dump("  " + folderURI + "\n");
      }
      dump("Interested wrappers:\n");
      for (const folderURI in IDBViewWrapperListener.prototype._FNH
        ._interestedWrappers) {
        dump("  " + folderURI + "\n");
      }
      dump("***\n");
      do_throw(msg);
    }
    // Force the folder to forget about the message database.
    this.active_virtual_folders.forEach(function (folder) {
      folder.msgDatabase = null;
    });
    this.active_real_folders.forEach(function (folder) {
      folder.msgDatabase = null;
    });

    this.active_view_wrappers.splice(0);
    this.active_real_folders.splice(0);
    this.active_virtual_folders.splice(0);

    gMockViewWrapperListener.allMessagesLoadedEventCount = 0;
  },
  onTimeout() {
    dump("-----------------------------------------------------------\n");
    dump("Active things at time of timeout:\n");
    for (const folder of this.active_real_folders) {
      dump("Real folder: " + folder.prettyName + "\n");
    }
    for (const virtFolder of this.active_virtual_folders) {
      dump("Virtual folder: " + virtFolder.prettyName + "\n");
    }
    for (const [i, viewWrapper] of this.active_view_wrappers.entries()) {
      dump("-----------------------------------\n");
      dump("Active view wrapper " + i + "\n");
      dump_view_state(viewWrapper);
    }
  },
};

function make_view_wrapper() {
  const wrapper = new DBViewWrapper(gMockViewWrapperListener);
  VWTU_testHelper.active_view_wrappers.push(wrapper);
  return wrapper;
}

/**
 * Open a folder for view display.  This is an async operation, relying on the
 *  onMessagesLoaded(true) notification to get he test going again.
 */
async function view_open(aViewWrapper, aFolder) {
  aViewWrapper.listener.pendingLoad = true;
  aViewWrapper.open(aFolder);
  await gMockViewWrapperListener.promise;
  gMockViewWrapperListener.resetPromise();
}

async function view_set_mail_view(aViewWrapper, aMailViewIndex, aData) {
  aViewWrapper.listener.pendingLoad = true;
  aViewWrapper.setMailView(aMailViewIndex, aData);
  await gMockViewWrapperListener.promise;
  gMockViewWrapperListener.resetPromise();
}

async function view_refresh(aViewWrapper) {
  aViewWrapper.listener.pendingLoad = true;
  aViewWrapper.refresh();
  await gMockViewWrapperListener.promise;
  gMockViewWrapperListener.resetPromise();
}

async function view_group_by_sort(aViewWrapper, aGroupBySort) {
  aViewWrapper.listener.pendingLoad = true;
  aViewWrapper.showGroupedBySort = aGroupBySort;
  await gMockViewWrapperListener.promise;
  gMockViewWrapperListener.resetPromise();
}

/**
 * Call endViewUpdate on your wrapper in the async idiom.  This is essential if
 *  you are doing things to a cross-folder view which does its searching in a
 *  time-sliced fashion.  In such a case, you would call beginViewUpdate
 *  manually, then poke at the view, then call us to end the view update.
 */
function async_view_end_update(aViewWrapper) {
  aViewWrapper.listener.pendingLoad = true;
  aViewWrapper.endViewUpdate();
  return false;
}

/**
 * The deletion is asynchronous from a view perspective because the view ends
 *  up re-creating itself which triggers a new search.  This function is
 *  nominally asynchronous because we refresh XFVF views when one of their
 *  folders gets deleted.  In that case, you must pass the view wrapper you
 *  expect to be affected so we can do our async thing.
 * If, however, you are deleting the last folder that belongs to a view, you
 *  should not pass a view wrapper, because you should expect the view wrapper
 *  to close itself and destroy the view.  (Well, the view might do something
 *  too, but we don't care what it does.)  We provide a |delete_folder| alias
 *  so code can look clean.
 *
 * @param {nsIMsgFolder} aFolder - The folder
 * @param {DBViewWrapper} aViewWrapper - Required when you want us to operate
 *   asynchronously.
 * @param {boolean} aDontEmptyTrash - delete_folder will empty the trash after
 *   deleting the folder, unless you set this parameter to true.
 */
async function delete_folder(aFolder, aViewWrapper, aDontEmptyTrash) {
  VWTU_testHelper.active_real_folders.splice(
    VWTU_testHelper.active_real_folders.indexOf(aFolder),
    1
  );
  // Deleting tries to be helpful and move the folder to the trash...
  aFolder.deleteSelf(null);

  // Ugh.  So we have the problem where that move above just triggered a
  //  re-computation of the view... which is an asynchronous operation
  //  that we don't care about at all.  We don't need to wait for it to
  //  complete, but if we don't, we have a race on enabling this next
  //  notification.
  // So we interrupt the search ourselves.  This problem is exclusively
  //  limited to unit testing and is not something we would need to do
  //  normally.  (Because things are single-threaded we are also
  //  guaranteed that we can interrupt it without needing locks or anything.)
  if (aViewWrapper) {
    if (aViewWrapper.searching) {
      aViewWrapper.search.session.interruptSearch();
    }
    aViewWrapper.listener.pendingLoad = true;
  }

  // ...so now the stupid folder is in the stupid trash.
  // Let's empty the trash, then, shall we?
  // (For local folders it doesn't matter who we call this on.)
  if (!aDontEmptyTrash) {
    aFolder.emptyTrash(null);
  }

  await gMockViewWrapperListener.promise;
  gMockViewWrapperListener.resetPromise();
}

/**
 * For assistance in debugging, dump information about a message header.
 */
function dump_message_header(aMsgHdr) {
  dump("  Subject: " + aMsgHdr.mime2DecodedSubject + "\n");
  dump("  Date: " + new Date(aMsgHdr.date / 1000) + "\n");
  dump("  Author: " + aMsgHdr.mime2DecodedAuthor + "\n");
  dump("  Recipients: " + aMsgHdr.mime2DecodedRecipients + "\n");
  const junkScore = aMsgHdr.getStringProperty("junkscore");
  dump(
    "  Read: " +
      aMsgHdr.isRead +
      "   Flagged: " +
      aMsgHdr.isFlagged +
      "   Killed: " +
      aMsgHdr.isKilled +
      "   Junk: " +
      (junkScore == "100") +
      "\n"
  );
  dump("  Keywords: " + aMsgHdr.getStringProperty("Keywords") + "\n");
  dump(
    "  Folder: " +
      aMsgHdr.folder.prettyName +
      "  Key: " +
      aMsgHdr.messageKey +
      "\n"
  );
}

/**
 * Verify that the messages in the provided SyntheticMessageSets are the only
 *  visible messages in the provided DBViewWrapper. If dummy headers are present
 *  in the view for group-by-sort, the code will ensure that the dummy header's
 *  underlying header corresponds to a message in the synthetic sets.  However,
 *  you should generally not rely on this code to test for anything involving
 *  dummy headers.
 *
 * In the event the view does not contain all of the messages from the provided
 *  sets or contains messages not in the provided sets, do_throw will be invoked
 *  with a human readable explanation of the problem.
 *
 * @param {SyntheticMessageSet|SyntheticMessageSet[]} aSynSets - A single
 *   SyntheticMessageSet or a list of SyntheticMessageSets.
 * @param {DBViewWrapper} aViewWrapper - The DBViewWrapper whose contents you
 *   want to validate.
 */
function verify_messages_in_view(aSynSets, aViewWrapper) {
  if (!("length" in aSynSets)) {
    aSynSets = [aSynSets];
  }

  // - Iterate over all the message sets, retrieving the message header.  Use
  //  this to construct a URI to populate a dictionary mapping.
  const synMessageURIs = {}; // map URI to message header
  for (const messageSet of aSynSets) {
    for (const msgHdr of messageSet.msgHdrs()) {
      synMessageURIs[msgHdr.folder.getUriForMsg(msgHdr)] = msgHdr;
    }
  }

  // - Iterate over the contents of the view, nulling out values in
  //  synMessageURIs for found messages, and exploding for missing ones.
  const dbView = aViewWrapper.dbView;
  const treeView = aViewWrapper.dbView.QueryInterface(Ci.nsITreeView);
  const rowCount = treeView.rowCount;

  for (let iViewIndex = 0; iViewIndex < rowCount; iViewIndex++) {
    const msgHdr = dbView.getMsgHdrAt(iViewIndex);
    const uri = msgHdr.folder.getUriForMsg(msgHdr);
    // Expected hit, null it out. (in the dummy case, we will just null out
    //  twice, which is also why we do an 'in' test and not a value test.
    if (uri in synMessageURIs) {
      synMessageURIs[uri] = null;
    } else {
      // The view is showing a message that should not be shown, explode.
      dump(
        "The view is showing the following message header and should not" +
          " be:\n"
      );
      dump_message_header(msgHdr);
      dump("View State:\n");
      dump_view_state(aViewWrapper);
      throw new Error(
        "view contains header that should not be present! " + msgHdr.messageKey
      );
    }
  }

  // - Iterate over our URI set and make sure every message got nulled out.
  for (const uri in synMessageURIs) {
    const msgHdr = synMessageURIs[uri];
    if (msgHdr != null) {
      dump("************************\n");
      dump(
        "The view should have included the following message header but" +
          " did not:\n"
      );
      dump_message_header(msgHdr);
      dump("View State:\n");
      dump_view_state(aViewWrapper);
      throw new Error(
        "view does not contain a header that should be present! " +
          msgHdr.messageKey
      );
    }
  }
}

/**
 * Assert if the view wrapper is displaying any messages.
 */
function verify_empty_view(aViewWrapper) {
  verify_messages_in_view([], aViewWrapper);
}

/**
 * Build a histogram of the treeview levels and verify it matches the expected
 *  histogram.  Oddly enough, I find this to be a reasonable and concise way to
 *  verify that threading mode is enabled.  Keep in mind that this file is
 *  currently not used to test the actual thread logic.  If/when that day comes,
 *  something less eccentric is certainly the way that should be tested.
 */
function verify_view_level_histogram(aExpectedHisto, aViewWrapper) {
  const treeView = aViewWrapper.dbView.QueryInterface(Ci.nsITreeView);
  const rowCount = treeView.rowCount;

  const actualHisto = {};
  for (let iViewIndex = 0; iViewIndex < rowCount; iViewIndex++) {
    const level = treeView.getLevel(iViewIndex);
    actualHisto[level] = (actualHisto[level] || 0) + 1;
  }

  for (const [level, count] of Object.entries(aExpectedHisto)) {
    if (actualHisto[level] != count) {
      dump_view_state(aViewWrapper);
      dump("*******************\n");
      dump(
        "Expected count for histogram level " +
          level +
          " was " +
          count +
          " but got " +
          actualHisto[level] +
          "\n"
      );
      do_throw("View histogram does not match!");
    }
  }
}

/**
 * Given a view wrapper and one or more view indices, verify that the row
 *  returns true for isContainer.
 *
 * @param {DBViewWrapper} aViewWrapper - The view wrapper in question.
 * @param {...integer} aArgs - View indices to check.
 */
function verify_view_row_at_index_is_container(aViewWrapper, ...aArgs) {
  const treeView = aViewWrapper.dbView.QueryInterface(Ci.nsITreeView);
  for (const viewIndex of aArgs) {
    if (!treeView.isContainer(viewIndex)) {
      dump_view_state(aViewWrapper);
      do_throw("Expected isContainer to be true at view index " + viewIndex);
    }
  }
}

/**
 * Given a view wrapper and one or more view indices, verify that there is a
 *  dummy header at each provided index.
 *
 * @param {DBViewWrapper} aViewWrapper - The view wrapper in question.
 * @param {...integer} aArgs - View indices to check.
 */
function verify_view_row_at_index_is_dummy(aViewWrapper, ...aArgs) {
  const MSG_VIEW_FLAG_DUMMY = 0x20000000;
  for (const viewIndex of aArgs) {
    const flags = aViewWrapper.dbView.getFlagsAt(viewIndex);
    if (!(flags & MSG_VIEW_FLAG_DUMMY)) {
      dump_view_state(aViewWrapper);
      do_throw("Expected a dummy header at view index " + viewIndex);
    }
  }
}

/**
 * Expand all nodes in the view wrapper.  This is a debug helper function
 *  because there's no good reason to have it be on the view wrapper at this
 *  time.  You must call async_view_refresh or async_view_end_update (if you are
 *  within a view update batch) after calling this!
 */
function view_expand_all(aViewWrapper) {
  // We can't use the command because it has assertions about having a tree.
  aViewWrapper._viewFlags |= Ci.nsMsgViewFlagsType.kExpandAll;
}

/**
 * Create a name and address pair where the provided word is part of the name.
 */
function make_person_with_word_in_name(aWord) {
  const dude = gMessageGenerator.makeNameAndAddress();
  return [aWord, dude[1]];
}

class MockViewWrapperListener extends IDBViewWrapperListener {
  shouldUseMailViews = true;
  shouldDeferMessageDisplayUntilAfterServerConnect = false;
  messenger = null;
  // Use no message window!
  msgWindow = null;
  threadPaneCommandUpdater = gFakeCommandUpdater;
  // Event handlers.
  allMessagesLoadedEventCount = 0;
  messagesRemovedEventCount = 0;

  constructor() {
    super();
    this._promise = new Promise(resolve => {
      this._resolve = resolve;
    });
  }

  shouldMarkMessagesReadOnLeavingFolder(aMsgFolder) {
    return Services.prefs.getBoolPref(
      "mailnews.mark_message_read." + aMsgFolder.server.type
    );
  }

  onMessagesLoaded(aAll) {
    if (!aAll) {
      return;
    }
    this.allMessagesLoadedEventCount++;
    if (this.pendingLoad) {
      this.pendingLoad = false;
      this._resolve();
    }
  }

  onMessagesRemoved() {
    this.messagesRemovedEventCount++;
  }

  get promise() {
    return this._promise;
  }
  resetPromise() {
    this._promise = new Promise(resolve => {
      this._resolve = resolve;
    });
  }
}
