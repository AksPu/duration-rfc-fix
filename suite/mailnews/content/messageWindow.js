/* -*- indent-tabs-mode: nil; js-indent-level: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const { MailUtils } = ChromeUtils.import("resource:///modules/MailUtils.js");

/* This is where functions related to the standalone message window are kept */

// from MailNewsTypes.h
const nsMsgKey_None = 0xFFFFFFFF;
const nsMsgViewIndex_None = 0xFFFFFFFF;

/* globals for a particular window */

var gCurrentMessageUri;
var gCurrentFolderUri;
var gThreadPaneCommandUpdater = null;
var gCurrentMessageIsDeleted = false;
var gNextMessageViewIndexAfterDelete = -2;
var gCurrentFolderToRerootForStandAlone;
var gRerootOnFolderLoadForStandAlone = false;
var gNextMessageAfterLoad = null;

// the folderListener object
var folderListener = {
  onFolderAdded: function(parentFolder, child) {},
  onMessageAdded: function(parentFolder, msg) {},
  onFolderRemoved: function(parentFolder, child) {},
  onMessageRemoved: function(parentFolder, msg)
  {
    if (parentFolder.URI != gCurrentFolderUri)
      return;
    if (extractMsgKeyFromURI() == msg.messageKey)
      gCurrentMessageIsDeleted = true;
  },

  onFolderPropertyChanged: function(item, property, oldValue, newValue) {},
  onFolderIntPropertyChanged: function(item, property, oldValue, newValue) {
    if (item.URI == gCurrentFolderUri) {
      if (property == "TotalMessages" || property == "TotalUnreadMessages") {
        UpdateStandAloneMessageCounts();
      }
    }
  },
  onFolderBoolPropertyChanged: function(item, property, oldValue, newValue) {},
  onFolderUnicharPropertyChanged: function(item, property, oldValue, newValue){},
  onFolderPropertyFlagChanged: function(item, property, oldFlag, newFlag) {},

  onFolderEvent: function(folder, event) {
    if (event == "DeleteOrMoveMsgCompleted")
      HandleDeleteOrMoveMsgCompleted(folder);
    else if (event == "DeleteOrMoveMsgFailed")
      HandleDeleteOrMoveMsgFailed(folder);
    else if (event == "FolderLoaded") {
      if (folder) {
        var uri = folder.URI;
        if (uri == gCurrentFolderToRerootForStandAlone) {
          gCurrentFolderToRerootForStandAlone = null;
          folder.endFolderLoading();
          if (gRerootOnFolderLoadForStandAlone) {
            RerootFolderForStandAlone(uri);
          }
        }
      }
    }
    else if (event == "JunkStatusChanged") {
      HandleJunkStatusChanged(folder);
    }
  }
}

var messagepaneObserver = {
  onDrop(aEvent) {
    let dragSession = Cc["@mozilla.org/widget/dragservice;1"]
                        .getService(Ci.nsIDragService)
                        .getCurrentSession();
    if (!this.canDrop(aEvent, dragSession)) {
      return;
    }
    let sourceUri = aEvent.dataTransfer.getData("text/x-moz-message");
    if (sourceUri != gCurrentMessageUri)
    {
      var msgHdr = GetMsgHdrFromUri(sourceUri);

      // Reset the window's message uri and folder uri vars, and
      // update the command handlers to what's going to be used.
      // This has to be done before the call to CreateView().
      gCurrentMessageUri = sourceUri;
      gCurrentFolderUri = msgHdr.folder.URI;
      UpdateMailToolbar('onDrop');

      // even if the folder uri's match, we can't use the existing view
      // (msgHdr.folder.URI == windowID.gCurrentFolderUri)
      // the reason is quick search and mail views.
      // see bug #187673
      CreateView(dragSession.sourceNode.ownerDocument.defaultView.gDBView);
      LoadMessageByMsgKey(msgHdr.messageKey);
    }
    aEvent.stopPropagation();
  },

  onDragOver(aEvent) {
    var messagepanebox = document.getElementById("messagepanebox");
    messagepanebox.setAttribute("dragover", "true");
    aEvent.stopPropagation();
    aEvent.preventDefault();
  },

  onDragExit(aEvent) {
    var messagepanebox = document.getElementById("messagepanebox");
    messagepanebox.removeAttribute("dragover");
  },

  canDrop(aEvent, aDragSession) {
    // Allow drop from mail:3pane window only - 4xp.
    var doc = aDragSession.sourceNode.ownerDocument;
    var elem = doc.getElementById("messengerWindow");
    return (elem && (elem.getAttribute("windowtype") == "mail:3pane"));
  },
};

function nsMsgDBViewCommandUpdater()
{}

function UpdateStandAloneMessageCounts()
{
  // hook for extra toolbar items
  Services.obs.notifyObservers(window,
                               "mail:updateStandAloneMessageCounts");
}

nsMsgDBViewCommandUpdater.prototype =
{
  updateCommandStatus : function()
    {
      // the back end is smart and is only telling us to update command status
      // when the # of items in the selection has actually changed.
      UpdateMailToolbar("dbview, std alone window");
    },

  displayMessageChanged : function(aFolder, aSubject, aKeywords)
  {
    setTitleFromFolder(aFolder, aSubject);
    ClearPendingReadTimer(); // we are loading / selecting a new message so kill the mark as read timer for the currently viewed message
    gCurrentMessageUri = gDBView.URIForFirstSelectedMessage;
    UpdateStandAloneMessageCounts();
    goUpdateCommand("button_delete");
    goUpdateCommand("button_junk");
    goUpdateCommand("button_goBack");
    goUpdateCommand("button_goForward");
  },

  updateNextMessageAfterDelete : function()
  {
    SetNextMessageAfterDelete();
  },

  summarizeSelection: function() {return false},

  QueryInterface: ChromeUtils.generateQI([Ci.nsIMsgDBViewCommandUpdater]),
}

function HandleDeleteOrMoveMsgCompleted(folder)
{
  if ((folder.URI == gCurrentFolderUri) && gCurrentMessageIsDeleted)
  {
    gDBView.onDeleteCompleted(true);
    gCurrentMessageIsDeleted = false;
    if (gNextMessageViewIndexAfterDelete != nsMsgViewIndex_None)
    {
      var nextMstKey = gDBView.getKeyAt(gNextMessageViewIndexAfterDelete);
      if (nextMstKey != nsMsgKey_None &&
          !Services.prefs.getBoolPref("mail.close_message_window.on_delete"))
        LoadMessageByViewIndex(gNextMessageViewIndexAfterDelete);
      else
        window.close();
    }
    else
    {
      // close the stand alone window because there are no more messages in the folder
      window.close();
    }
  }
}

function HandleDeleteOrMoveMsgFailed(folder)
{
  gDBView.onDeleteCompleted(false);
  if ((folder.URI == gCurrentFolderUri) && gCurrentMessageIsDeleted)
    gCurrentMessageIsDeleted = false;
}

function IsCurrentLoadedFolder(folder)
{
  return (folder.URI == gCurrentFolderUri);
}

function OnLoadMessageWindow()
{
  AddMailOfflineObserver();
  CreateMailWindowGlobals();
  verifyAccounts(null);

  InitMsgWindow();

  messenger.setWindow(window, msgWindow);
  // FIX ME - later we will be able to use onload from the overlay
  OnLoadMsgHeaderPane();

  var nsIFolderListener = Ci.nsIFolderListener;
  var notifyFlags = nsIFolderListener.removed | nsIFolderListener.event |
                    nsIFolderListener.intPropertyChanged;
  MailServices.mailSession.AddFolderListener(folderListener, notifyFlags);

  var originalView = null;
  var folder = null;
  var messageUri;
  var loadCustomMessage = false;       //set to true when either loading a message/rfc822 attachment or a .eml file
  if (window.arguments)
  {
    if (window.arguments[0])
    {
      try
      {
        messageUri = window.arguments[0];
        if (messageUri instanceof Ci.nsIURI)
        {
          loadCustomMessage = /type=application\/x-message-display/.test(messageUri.spec);
          gCurrentMessageUri = messageUri.spec;
          if (messageUri instanceof Ci.nsIMsgMailNewsUrl)
            folder = messageUri.folder;
        }
      }
      catch(ex)
      {
        folder = null;
        dump("## ex=" + ex + "\n");
      }

      if (!gCurrentMessageUri)
        gCurrentMessageUri = window.arguments[0];
    }
    else
      gCurrentMessageUri = null;

    if (window.arguments[1])
      gCurrentFolderUri = window.arguments[1];
    else
      gCurrentFolderUri = folder ? folder.URI : null;

    if (window.arguments[2])
      originalView = window.arguments[2];

  }

  CreateView(originalView);

  // Before and after callbacks for the customizeToolbar code
  var mailToolbox = getMailToolbox();
  mailToolbox.customizeInit = MailToolboxCustomizeInit;
  mailToolbox.customizeDone = MailToolboxCustomizeDone;
  mailToolbox.customizeChange = MailToolboxCustomizeChange;

  setTimeout(OnLoadMessageWindowDelayed, 0, loadCustomMessage);

  SetupCommandUpdateHandlers();

  window.addEventListener("AppCommand", HandleAppCommandEvent, true);
}

function HandleAppCommandEvent(evt)
{
  evt.stopPropagation();
  switch (evt.command)
  {
    case "Back":
      goDoCommand('cmd_goBack');
      break;
    case "Forward":
      goDoCommand('cmd_goForward');
      break;
    case "Stop":
      goDoCommand('cmd_stop');
      break;
    case "Search":
      goDoCommand('cmd_search');
      break;
    case "Bookmarks":
      toAddressBook();
      break;
    case "Reload":
      goDoCommand('cmd_reload');
      break;
    case "Home":
    default:
      break;
  }
}

function OnLoadMessageWindowDelayed(loadCustomMessage)
{
  gDBView.suppressMsgDisplay = false;
  if (loadCustomMessage)
    gDBView.loadMessageByUrl(gCurrentMessageUri);
  else
  {
    var msgKey = extractMsgKeyFromURI(gCurrentMessageUri);
    var viewIndex = gDBView.findIndexFromKey(msgKey, true);
    // the message may not appear in the view if loaded from a search dialog
    if (viewIndex != nsMsgViewIndex_None)
      LoadMessageByViewIndex(viewIndex);
    else
      messenger.openURL(gCurrentMessageUri);
  }
  gNextMessageViewIndexAfterDelete = gDBView.msgToSelectAfterDelete;
  UpdateStandAloneMessageCounts();

  // set focus to the message pane
  window.content.focus();

  // since we just changed the pane with focus we need to update the toolbar to reflect this
  // XXX TODO
  // can we optimize
  // and just update cmd_delete and button_delete?
  UpdateMailToolbar("focus");
}

function CreateView(originalView)
{
  var msgFolder = GetLoadedMsgFolder();

  // extract the sort type, the sort order,
  var sortType;
  var sortOrder;
  var viewFlags;
  var viewType;

  if (originalView)
  {
    viewType = originalView.viewType;
    viewFlags = originalView.viewFlags;
    sortType = originalView.sortType;
    sortOrder = originalView.sortOrder;
  }
  else if (msgFolder)
  {
    var msgDatabase = msgFolder.msgDatabase;
    if (msgDatabase)
    {
      var dbFolderInfo = msgDatabase.dBFolderInfo;
      sortType = dbFolderInfo.sortType;
      sortOrder = dbFolderInfo.sortOrder;
      viewFlags = dbFolderInfo.viewFlags;
      viewType = dbFolderInfo.viewType;
      msgDatabase = null;
      dbFolderInfo = null;
   }
  }
  else
  {
    viewType = nsMsgViewType.eShowSearch;
  }

  // create a db view
  CreateBareDBView(originalView, msgFolder, viewType, viewFlags, sortType, sortOrder);

  var uri;
  if (gCurrentMessageUri)
    uri = gCurrentMessageUri;
  else if (gCurrentFolderUri)
    uri = gCurrentFolderUri;
  else
    uri = null;

  SetUpToolbarButtons(uri);

  // hook for extra toolbar items
  Services.obs.notifyObservers(window, "mail:setupToolbarItems", uri);
}

function extractMsgKeyFromURI()
{
  var msgKey = -1;
  var msgHdr = messenger.msgHdrFromURI(gCurrentMessageUri);
  if (msgHdr)
    msgKey = msgHdr.messageKey;
  return msgKey;
}

function OnUnloadMessageWindow()
{
  window.removeEventListener("AppCommand", HandleAppCommandEvent, true);

  UnloadCommandUpdateHandlers();

  // FIX ME - later we will be able to use onunload from the overlay
  OnUnloadMsgHeaderPane();

  OnMailWindowUnload();
}

function GetSelectedMsgFolders()
{
  var msgFolder = GetLoadedMsgFolder();
  return msgFolder ? [msgFolder] : [];
}

function GetNumSelectedMessages()
{
  return (gCurrentMessageUri) ? 1 : 0;
}

function GetSelectedIndices(dbView)
{
  try {
    return dbView.getIndicesForSelection();
  }
  catch (ex) {
    dump("ex = " + ex + "\n");
    return null;
  }
}

function GetLoadedMsgFolder()
{
  return gCurrentFolderUri ? MailUtils.getFolderForURI(gCurrentFolderUri)
                           : null;
}

function GetLoadedMessage()
{
  return gCurrentMessageUri;
}

//Clear everything related to the current message. called after load start page.
function ClearMessageSelection()
{
  gCurrentMessageUri = null;
  gCurrentFolderUri = null;
  UpdateMailToolbar("clear msg, std alone window");
}

function SetNextMessageAfterDelete()
{
  gNextMessageViewIndexAfterDelete = gDBView.msgToSelectAfterDelete;
}

function SelectMsgFolder(msgfolder) {
  if (!msgfolder || msgfolder.isServer)
    return;

  let folderUri = msgfolder.URI;
  if (folderUri == gCurrentFolderUri)
    return;

  // close old folder view
  var dbview = GetDBView();
  if (dbview)
    dbview.close();

  gCurrentFolderToRerootForStandAlone = folderUri;

  if (msgfolder.manyHeadersToDownload)
  {
    gRerootOnFolderLoadForStandAlone = true;
    try
    {
      msgfolder.startFolderLoading();
      msgfolder.updateFolder(msgWindow);
    }
    catch(ex)
    {
      dump("Error loading with many headers to download: " + ex + "\n");
    }
  }
  else
  {
    RerootFolderForStandAlone(folderUri);
    gRerootOnFolderLoadForStandAlone = false;
    msgfolder.startFolderLoading();

    //Need to do this after rerooting folder.  Otherwise possibility of receiving folder loaded
    //notification before folder has actually changed.
    msgfolder.updateFolder(msgWindow);
  }
}

function RerootFolderForStandAlone(uri)
{
  gCurrentFolderUri = uri;

  // create new folder view
  CreateView(null);

  // now do the work to load the appropriate message
  if (gNextMessageAfterLoad) {
    var type = gNextMessageAfterLoad;
    gNextMessageAfterLoad = null;
    LoadMessageByNavigationType(type);
  }

  SetUpToolbarButtons(gCurrentFolderUri);

  UpdateMailToolbar("reroot folder in stand alone window");

  // hook for extra toolbar items
  Services.obs.notifyObservers(window, "mail:setupToolbarItems", uri);
}

function GetMsgHdrFromUri(messageUri)
{
  return messenger.msgHdrFromURI(messageUri);
}

function SelectMessage(messageUri)
{
  var msgHdr = GetMsgHdrFromUri(messageUri);
  LoadMessageByMsgKey(msgHdr.messageKey);
}

function ReloadMessage()
{
  gDBView.reloadMessage();
}

// MessageWindowController object (handles commands when one of the trees does not have focus)
var MessageWindowController =
{
  supportsCommand: function(command)
  {
    switch (command)
    {
      case "cmd_delete":
      case "cmd_stop":
      case "cmd_undo":
      case "cmd_redo":
      case "cmd_killThread":
      case "cmd_killSubthread":
      case "cmd_watchThread":
      case "button_delete":
      case "button_shiftDelete":
      case "button_junk":
      case "cmd_shiftDelete":
      case "cmd_saveAsTemplate":
      case "cmd_getMsgsForAuthAccounts":
      case "button_mark":
      case "cmd_markAsRead":
      case "cmd_markAsUnread":
      case "cmd_markAllRead":
      case "cmd_markThreadAsRead":
      case "cmd_markReadByDate":
      case "cmd_markAsFlagged":
      case "button_file":
      case "cmd_markAsJunk":
      case "cmd_markAsNotJunk":
      case "cmd_recalculateJunkScore":
      case "cmd_markAsShowRemote":
      case "cmd_markAsNotPhish":
      case "cmd_applyFiltersToSelection":
      case "cmd_applyFilters":
      case "cmd_runJunkControls":
      case "cmd_deleteJunk":
      case "cmd_nextMsg":
      case "button_next":
      case "cmd_nextUnreadMsg":
      case "cmd_nextFlaggedMsg":
      case "cmd_nextUnreadThread":
      case "cmd_previousMsg":
      case "cmd_previousUnreadMsg":
      case "cmd_previousFlaggedMsg":
      case "cmd_goBack":
      case "button_goBack":
      case "cmd_goForward":
      case "button_goForward":
        return (gDBView.keyForFirstSelectedMessage != nsMsgKey_None);
      case "cmd_viewPageSource":
        return GetNumSelectedMessages() > 0;
      case "cmd_reply":
      case "button_reply":
      case "cmd_replyList":
      case "cmd_replyGroup":
      case "cmd_replySender":
      case "cmd_replyall":
      case "cmd_replySenderAndGroup":
      case "cmd_replyAllRecipients":
      case "button_replyall":
      case "cmd_forward":
      case "button_forward":
      case "cmd_forwardInline":
      case "cmd_forwardAttachment":
      case "cmd_editAsNew":
      case "cmd_editDraftMsg":
      case "cmd_newMsgFromTemplate":
      case "cmd_editTemplateMsg":
      case "cmd_getNextNMessages":
      case "cmd_find":
      case "cmd_findNext":
      case "cmd_findPrev":
      case "button_search":
      case "cmd_search":
      case "cmd_reload":
      case "cmd_saveAsFile":
      case "cmd_getNewMessages":
      case "button_getNewMessages":
      case "button_print":
      case "cmd_print":
      case "cmd_printpreview":
      case "cmd_printSetup":
      case "cmd_settingsOffline":
      case "cmd_createFilterFromPopup":
      case "cmd_createFilterFromMenu":
      case "cmd_viewAllHeader":
      case "cmd_viewNormalHeader":
        return true;
      case "cmd_synchronizeOffline":
      case "cmd_downloadFlagged":
      case "cmd_downloadSelected":
        return !Services.io.offline;
      default:
        return false;
    }
  },

  isCommandEnabled: function(command)
  {
    var loadedFolder;
    var enabled = new Object();
    enabled.value = false;
    var checkStatus = new Object();

    switch (command)
    {
      case "cmd_createFilterFromPopup":
      case "cmd_createFilterFromMenu":
        loadedFolder = GetLoadedMsgFolder();
        return (loadedFolder && loadedFolder.server.canHaveFilters);
      case "cmd_delete":
        UpdateDeleteCommand();
        // fall through
      case "button_delete":
        if (command == "button_delete")
          UpdateDeleteToolbarButton(false);
        // fall through
      case "cmd_shiftDelete":
      case "button_shiftDelete":
        loadedFolder = GetLoadedMsgFolder();
        return gCurrentMessageUri && loadedFolder && loadedFolder.canDeleteMessages;
      case "button_junk":
        UpdateJunkToolbarButton();
        // fall through
      case "cmd_markAsJunk":
      case "cmd_markAsNotJunk":
        if (gDBView)
          gDBView.getCommandStatus(nsMsgViewCommandType.junk, enabled, checkStatus);
        return enabled.value;
      case "cmd_recalculateJunkScore":
        if (GetNumSelectedMessages() > 0 && gDBView)
          gDBView.getCommandStatus(nsMsgViewCommandType.runJunkControls, enabled, checkStatus);
        return enabled.value;
      case "cmd_reply":
      case "button_reply":
      case "cmd_replyList":
      case "cmd_replyGroup":
      case "cmd_replySender":
      case "cmd_replyall":
      case "button_replyall":
      case "cmd_replySenderAndGroup":
      case "cmd_replyAllRecipients":
      case "cmd_forward":
      case "button_forward":
      case "cmd_forwardInline":
      case "cmd_forwardAttachment":
      case "cmd_editAsNew":
      case "cmd_editDraftMsg":
      case "cmd_newMsgFromTemplate":
      case "cmd_editTemplateMsg":
      case "cmd_print":
      case "cmd_printpreview":
      case "button_print":
      case "cmd_saveAsFile":
        return true;
      case "cmd_saveAsTemplate":
        var target = getMessageBrowser().contentPrincipal.URI.scheme;
        return target != "news";
      case "cmd_viewPageSource":
      case "cmd_reload":
      case "cmd_find":
      case "button_mark":
      case "cmd_markAllRead":
      case "cmd_markThreadAsRead":
      case "cmd_markReadByDate":
      case "cmd_viewAllHeader":
      case "cmd_viewNormalHeader":
        return true;
      case "cmd_markAsRead":
        return CanMarkMsgAsRead(true);
      case "cmd_markAsUnread":
        return CanMarkMsgAsRead(false);
      case "cmd_markAsFlagged":
      case "button_file":
        return (gCurrentMessageUri != null);
      case "cmd_markAsShowRemote":
        return (GetNumSelectedMessages() > 0 && checkMsgHdrPropertyIsNot("remoteContentPolicy", kAllowRemoteContent));
      case "cmd_markAsNotPhish":
        return (GetNumSelectedMessages() > 0 && checkMsgHdrPropertyIsNot("notAPhishMessage", kNotAPhishMessage));
      case "cmd_printSetup":
        return true;
      case "cmd_getNewMessages":
      case "button_getNewMessages":
      case "cmd_getMsgsForAuthAccounts":
        return IsGetNewMessagesEnabled();
      case "cmd_getNextNMessages":
        return IsGetNextNMessagesEnabled();
      case "cmd_downloadFlagged":
      case "cmd_downloadSelected":
      case "cmd_synchronizeOffline":
        return !Services.io.offline;
      case "cmd_settingsOffline":
        return IsAccountOfflineEnabled();
      case "cmd_nextMsg":
      case "button_next":
      case "cmd_nextUnreadMsg":
      case "cmd_nextFlaggedMsg":
      case "cmd_nextUnreadThread":
      case "cmd_previousMsg":
      case "cmd_previousUnreadMsg":
      case "cmd_previousFlaggedMsg":
      case "cmd_applyFiltersToSelection":
        return true;
      case "cmd_findNext":
      case "cmd_findPrev":
        return MsgCanFindAgain();
      case "cmd_goBack":
      case "button_goBack":
        return gDBView && gDBView.navigateStatus(nsMsgNavigationType.back);
      case "cmd_goForward":
      case "button_goForward":
        return gDBView && gDBView.navigateStatus(nsMsgNavigationType.forward);
      case "button_search":
      case "cmd_search":
        loadedFolder = GetLoadedMsgFolder();
        return (loadedFolder && loadedFolder.server.canSearchMessages);
      case "cmd_stop":
        return true;
      case "cmd_undo":
      case "cmd_redo":
        return SetupUndoRedoCommand(command);
      case "cmd_applyFilters":
      case "cmd_runJunkControls":
      case "cmd_deleteJunk":
        return false;
      default:
        return false;
    }
  },

  doCommand: function(command)
  {
    // if the user invoked a key short cut then it is possible that we got here for a command which is
    // really disabled. kick out if the command should be disabled.
    if (!this.isCommandEnabled(command)) return;

    var navigationType = nsMsgNavigationType.nextUnreadMessage;

    switch ( command )
    {
      case "cmd_getNewMessages":
        MsgGetMessage();
        break;
      case "cmd_undo":
        messenger.undo(msgWindow);
        break;
      case "cmd_redo":
        messenger.redo(msgWindow);
        break;
      case "cmd_getMsgsForAuthAccounts":
        MsgGetMessagesForAllAuthenticatedAccounts();
        break;
      case "cmd_getNextNMessages":
        MsgGetNextNMessages();
        break;
      case "cmd_reply":
        MsgReplyMessage(null);
        break;
      case "cmd_replyList":
        MsgReplyList(null);
        break;
      case "cmd_replyGroup":
        MsgReplyGroup(null);
        break;
      case "cmd_replySender":
        MsgReplySender(null);
        break;
      case "cmd_replyall":
        MsgReplyToAllMessage(null);
        break;
      case "cmd_replySenderAndGroup":
        MsgReplyToSenderAndGroup(null);
        break;
      case "cmd_replyAllRecipients":
        MsgReplyToAllRecipients(null);
        break;
      case "cmd_forward":
        MsgForwardMessage(null);
        break;
      case "cmd_forwardInline":
        MsgForwardAsInline(null);
        break;
      case "cmd_forwardAttachment":
        MsgForwardAsAttachment(null);
        break;
      case "cmd_editAsNew":
        MsgEditMessageAsNew(null);
        break;
      case "cmd_editDraftMsg":
        MsgEditDraftMessage(null);
        break;
      case "cmd_newMsgFromTemplate":
        MsgNewMessageFromTemplate(null);
        break;
      case "cmd_editTemplateMsg":
        MsgEditTemplateMessage(null);
        break;
      case "cmd_createFilterFromPopup":
        CreateFilter(document.popupNode);
        break;
      case "cmd_createFilterFromMenu":
        MsgCreateFilter();
        break;
      case "cmd_delete":
      case "button_delete":
        MsgDeleteMessage(false);
        UpdateDeleteToolbarButton(false);
        break;
      case "cmd_shiftDelete":
      case "button_shiftDelete":
        MsgDeleteMessage(true);
        break;
      case "button_junk":
        MsgJunk();
        break;
      case "cmd_stop":
        MsgStop();
        break;
      case "cmd_printSetup":
        PrintUtils.showPageSetup();
        break;
      case "cmd_print":
        PrintEnginePrint();
        break;
      case "cmd_printpreview":
        PrintEnginePrintPreview();
        break;
      case "cmd_saveAsFile":
        MsgSaveAsFile();
        break;
      case "cmd_saveAsTemplate":
        MsgSaveAsTemplate();
        break;
      case "cmd_viewPageSource":
        MsgViewPageSource();
        break;
      case "cmd_reload":
        ReloadMessage();
        break;
      case "cmd_find":
        MsgFind();
        break;
      case "cmd_findNext":
        MsgFindAgain(false);
        break;
      case "cmd_findPrev":
        MsgFindAgain(true);
        break;
      case "button_search":
      case "cmd_search":
        MsgSearchMessages();
        break;
      case "button_mark":
        MsgMarkMsgAsRead();
        return;
      case "cmd_markAsRead":
        MsgMarkMsgAsRead(true);
        return;
      case "cmd_markAsUnread":
        MsgMarkMsgAsRead(false);
        return;
      case "cmd_markThreadAsRead":
        MsgMarkThreadAsRead();
        return;
      case "cmd_markAllRead":
        MsgMarkAllRead();
        return;
      case "cmd_markReadByDate":
        MsgMarkReadByDate();
        return;
      case "cmd_viewAllHeader":
        MsgViewAllHeaders();
        return;
      case "cmd_viewNormalHeader":
        MsgViewNormalHeaders();
        return;
      case "cmd_markAsFlagged":
        MsgMarkAsFlagged();
        return;
      case "cmd_markAsJunk":
        JunkSelectedMessages(true);
        return;
      case "cmd_markAsNotJunk":
        JunkSelectedMessages(false);
        return;
      case "cmd_recalculateJunkScore":
        analyzeMessagesForJunk();
        return;
      case "cmd_markAsShowRemote":
        LoadMsgWithRemoteContent();
        return;
      case "cmd_markAsNotPhish":
        MsgIsNotAScam();
        return;
      case "cmd_downloadFlagged":
        MsgDownloadFlagged();
        return;
      case "cmd_downloadSelected":
        MsgDownloadSelected();
        return;
      case "cmd_synchronizeOffline":
        MsgSynchronizeOffline();
        return;
      case "cmd_settingsOffline":
        MsgSettingsOffline();
        return;
      case "cmd_nextUnreadMsg":
      case "button_next":
        performNavigation(nsMsgNavigationType.nextUnreadMessage);
        break;
      case "cmd_nextUnreadThread":
        performNavigation(nsMsgNavigationType.nextUnreadThread);
        break;
      case "cmd_nextMsg":
        performNavigation(nsMsgNavigationType.nextMessage);
        break;
      case "cmd_nextFlaggedMsg":
        performNavigation(nsMsgNavigationType.nextFlagged);
        break;
      case "cmd_previousMsg":
        performNavigation(nsMsgNavigationType.previousMessage);
        break;
      case "cmd_previousUnreadMsg":
        performNavigation(nsMsgNavigationType.previousUnreadMessage);
        break;
      case "cmd_previousFlaggedMsg":
        performNavigation(nsMsgNavigationType.previousFlagged);
        break;
      case "cmd_goBack":
        performNavigation(nsMsgNavigationType.back);
        break;
      case "cmd_goForward":
        performNavigation(nsMsgNavigationType.forward);
        break;
      case "cmd_applyFiltersToSelection":
        MsgApplyFiltersToSelection();
        break;
    }
  },

  onEvent: function(event)
  {
  }
};

function LoadMessageByNavigationType(type)
{
  var resultId = new Object;
  var resultIndex = new Object;
  var threadIndex = new Object;

  gDBView.viewNavigate(type, resultId, resultIndex, threadIndex, true /* wrap */);

  // if we found something....display it.
  if ((resultId.value != nsMsgKey_None) && (resultIndex.value != nsMsgKey_None))
  {
    // load the message key
    LoadMessageByMsgKey(resultId.value);
    // if we changed folders, the message counts changed.
    UpdateStandAloneMessageCounts();

    // new message has been loaded
    return true;
  }

  // no message found to load
  return false;
}

function performNavigation(type)
{
  // Try to load a message by navigation type if we can find
  // the message in the same folder.
  if (LoadMessageByNavigationType(type))
    return;

  CrossFolderNavigation(type);
}

function SetupCommandUpdateHandlers()
{
  top.controllers.insertControllerAt(0, MessageWindowController);
}

function UnloadCommandUpdateHandlers()
{
  top.controllers.removeController(MessageWindowController);
}

function GetDBView()
{
  return gDBView;
}

function LoadMessageByMsgKey(messageKey)
{
  var viewIndex = gDBView.findIndexFromKey(messageKey, true);
  gDBView.loadMessageByViewIndex(viewIndex);
 // we only want to update the toolbar if there was no previous selected message.
  if (nsMsgKey_None == gDBView.keyForFirstSelectedMessage)
    UpdateMailToolbar("update toolbar for message Window");
}

function LoadMessageByViewIndex(viewIndex)
{
  gDBView.loadMessageByViewIndex(viewIndex);
  // we only want to update the toolbar if there was no previous selected message.
  if (nsMsgKey_None == gDBView.keyForFirstSelectedMessage)
    UpdateMailToolbar("update toolbar for message Window");
}
