/* -*- indent-tabs-mode: nil; js-indent-level: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

var { AppConstants } =
  ChromeUtils.import("resource://gre/modules/AppConstants.jsm");

var gLastMessageUriToLoad = null;
var gThreadPaneCommandUpdater = null;

function ThreadPaneOnClick(event)
{
  // usually, we're only interested in tree content clicks, not scrollbars etc.
  let t = event.originalTarget;

  // we may want to open the message in a new tab on middle click
  if (event.button == kMouseButtonMiddle)
  {
    if (t.localName == "treechildren" && AllowOpenTabOnMiddleClick())
    {
      // we don't allow new tabs in the search dialog
      if (document.documentElement.id != "searchMailWindow")
      {
        OpenMessageInNewTab(event);
        RestoreSelectionWithoutContentLoad(GetThreadTree());
      }
      return;
    }
  }

  // otherwise, we only care about left click events
  if (event.button != kMouseButtonLeft)
    return;

  // We are already handling marking as read and flagging in nsMsgDBView.cpp,
  // so all we need to worry about here is double clicks and column header.
  // We also get in here for clicks on the "treecol" (headers) and the
  // "scrollbarbutton" (scrollbar buttons), but we don't want those events to
  // cause a "double click".
  if (t.localName == "treecol")
  {
    HandleColumnClick(t.id);
  }
  else if (t.localName == "treechildren")
  {
    let tree = GetThreadTree();
    // figure out what cell the click was in
    var cell = tree.treeBoxObject.getCellAt(event.clientX, event.clientY);
    if (cell.row == -1)
      return;

    // If the cell is in a "cycler" column or if the user double clicked on the
    // twisty, don't open the message in a new window.
    if (event.detail == 2 && !cell.col.cycler && (cell.childElt != "twisty"))
    {
      ThreadPaneDoubleClick(event);
      // Double clicking should not toggle the open/close state of the thread.
      // This will happen if we don't prevent the event from bubbling to the
      // default handler in tree.xml.
      event.stopPropagation();
    }
    else if (cell.col.id == "junkStatusCol")
    {
      MsgJunkMailInfo(true);
    }
    else if (cell.col.id == "threadCol" && !event.shiftKey && (event.ctrlKey || event.metaKey))
    {
      gDBView.ExpandAndSelectThreadByIndex(cell.row, true);
      event.stopPropagation();
    }
  }
}

function nsMsgDBViewCommandUpdater()
{}

nsMsgDBViewCommandUpdater.prototype =
{
  updateCommandStatus : function()
    {
      // the back end is smart and is only telling us to update command status
      // when the # of items in the selection has actually changed.
      UpdateMailToolbar("dbview driven, thread pane");
    },

  displayMessageChanged : function(aFolder, aSubject, aKeywords)
  {
    if (!gDBView.suppressMsgDisplay)
      setTitleFromFolder(aFolder, aSubject);
    ClearPendingReadTimer(); // we are loading / selecting a new message so kill the mark as read timer for the currently viewed message
    gHaveLoadedMessage = true;
    goUpdateCommand("button_delete");
    goUpdateCommand("button_junk");
  },

  updateNextMessageAfterDelete : function()
  {
    SetNextMessageAfterDelete();
  },

  summarizeSelection: function() {return false},

  QueryInterface: ChromeUtils.generateQI([Ci.nsIMsgDBViewCommandUpdater]),
}

function HandleColumnClick(columnID)
{
  const columnMap = {dateCol: 'byDate',
                     receivedCol: 'byReceived',
                     senderCol: 'byAuthor',
                     recipientCol: 'byRecipient',
                     subjectCol: 'bySubject',
                     locationCol: 'byLocation',
                     accountCol: 'byAccount',
                     unreadButtonColHeader: 'byUnread',
                     statusCol: 'byStatus',
                     sizeCol: 'bySize',
                     priorityCol: 'byPriority',
                     flaggedCol: 'byFlagged',
                     threadCol: 'byThread',
                     tagsCol: 'byTags',
                     junkStatusCol: 'byJunkStatus',
                     idCol: 'byId',
                     attachmentCol: 'byAttachments'};


  var sortType;
  if (columnID in columnMap) {
    sortType = columnMap[columnID];
  } else {
    // If the column isn't in the map, check and see if it's a custom column
    try {
      // try to grab the columnHandler (an error is thrown if it does not exist)
      columnHandler = gDBView.getColumnHandler(columnID);

      // it exists - save this column ID in the customSortCol property of
      // dbFolderInfo for later use (see nsIMsgDBView.cpp)
      gDBView.db.dBFolderInfo.setProperty('customSortCol', columnID);

      sortType = "byCustom";
    } catch(err) {
        dump("unsupported sort column: " + columnID + " - no custom handler installed. (Error was: " + err + ")\n");
        return; // bail out
    }
  }

  var dbview = GetDBView();
  var simpleColumns = false;
  try {
    simpleColumns = !Services.prefs.getBoolPref("mailnews.thread_pane_column_unthreads");
  }
  catch (ex) {
  }
  if (sortType == "byThread") {
    if (simpleColumns)
      MsgToggleThreaded();
    else if (dbview.viewFlags & nsMsgViewFlagsType.kThreadedDisplay)
      MsgReverseSortThreadPane();
    else
      MsgSortByThread();
  }
  else {
    if (!simpleColumns && (dbview.viewFlags & nsMsgViewFlagsType.kThreadedDisplay)) {
      dbview.viewFlags &= ~nsMsgViewFlagsType.kThreadedDisplay;
      MsgSortThreadPane(sortType);
    }
    else if (dbview.sortType == nsMsgViewSortType[sortType]) {
      MsgReverseSortThreadPane();
    }
    else {
      MsgSortThreadPane(sortType);
    }
  }
}

function ThreadPaneDoubleClick(event) {
  if (IsSpecialFolderSelected(Ci.nsMsgFolderFlags.Drafts, true))
  {
    MsgComposeDraftMessage();
  }
  else if (IsSpecialFolderSelected(Ci.nsMsgFolderFlags.Templates, true))
  {
    ComposeMsgByType(Ci.nsIMsgCompType.Template, null,
                     Ci.nsIMsgCompFormat.Default);
  }
  else if (AllowOpenTabOnDoubleClick() &&
           document.documentElement.id != "searchMailWindow")
  {        // we don't allow new tabs in the search dialog
    // open the message in a new tab on double click
    OpenMessageInNewTab(event);
    RestoreSelectionWithoutContentLoad(GetThreadTree());
  }
  else
  {
    MsgOpenSelectedMessages();
  }
}

function ThreadPaneKeyPress(event)
{
  if (event.keyCode == KeyEvent.DOM_VK_RETURN) {
    if ((AppConstants.platform == "macosx" ? event.metaKey : event.ctrlKey) &&
        AllowOpenTabOnMiddleClick()) {
      OpenMessageInNewTab(event);
    } else {
      ThreadPaneDoubleClick(event);
    }
  }
}

function MsgSortByThread()
{
  var dbview = GetDBView();
  dbview.viewFlags |= nsMsgViewFlagsType.kThreadedDisplay;
  dbview.viewFlags &= ~nsMsgViewFlagsType.kGroupBySort;
  MsgSortThreadPane('byDate');
}

function MsgSortThreadPane(sortName)
{
  var sortType = nsMsgViewSortType[sortName];
  var dbview = GetDBView();

  // turn off grouping
  dbview.viewFlags &= ~nsMsgViewFlagsType.kGroupBySort;

  dbview.sort(sortType, nsMsgViewSortOrder.ascending);
  UpdateSortIndicators(sortType, nsMsgViewSortOrder.ascending);
}

function MsgReverseSortThreadPane()
{
  var dbview = GetDBView();
  if (dbview.sortOrder == nsMsgViewSortOrder.ascending) {
    MsgSortDescending();
  }
  else {
    MsgSortAscending();
  }
}

function MsgToggleThreaded()
{
    var dbview = GetDBView();
    var newViewFlags = dbview.viewFlags ^ nsMsgViewFlagsType.kThreadedDisplay;
    newViewFlags &= ~nsMsgViewFlagsType.kGroupBySort;
    dbview.viewFlags = newViewFlags;

    dbview.sort(dbview.sortType, dbview.sortOrder);
    UpdateSortIndicators(dbview.sortType, dbview.sortOrder);
}

function MsgSortThreaded()
{
    var dbview = GetDBView();
    var viewFlags = dbview.viewFlags;
    let wasGrouped = viewFlags & nsMsgViewFlagsType.kGroupBySort;
    dbview.viewFlags &= ~nsMsgViewFlagsType.kGroupBySort;
    // if we were grouped, and not a saved search, just rebuild the view
    if (wasGrouped && !(gMsgFolderSelected.flags &
                       Ci.nsMsgFolderFlags.Virtual))
      SwitchView("cmd_viewAllMsgs");
    // Toggle if not already threaded.
    else if ((viewFlags & nsMsgViewFlagsType.kThreadedDisplay) == 0)
        MsgToggleThreaded();
}

function MsgGroupBySort()
{
  var dbview = GetDBView();
  var viewFlags = dbview.viewFlags;
  var sortOrder = dbview.sortOrder;
  var sortType = dbview.sortType;
  var count = new Object;
  var msgFolder = dbview.msgFolder;

  var sortTypeSupportsGrouping = (sortType == nsMsgViewSortType.byAuthor
         || sortType == nsMsgViewSortType.byDate || sortType == nsMsgViewSortType.byReceived || sortType == nsMsgViewSortType.byPriority
         || sortType == nsMsgViewSortType.bySubject || sortType == nsMsgViewSortType.byTags
         || sortType == nsMsgViewSortType.byStatus  || sortType == nsMsgViewSortType.byRecipient
         || sortType == nsMsgViewSortType.byAccount || sortType == nsMsgViewSortType.byFlagged
         || sortType == nsMsgViewSortType.byAttachments);

  if (!sortTypeSupportsGrouping)
    return; // we shouldn't be trying to group something we don't support grouping for...

  viewFlags |= nsMsgViewFlagsType.kThreadedDisplay | nsMsgViewFlagsType.kGroupBySort;
  if (gDBView &&
      gMsgFolderSelected.flags & Ci.nsMsgFolderFlags.Virtual)
  {
    gDBView.viewFlags = viewFlags;
    UpdateSortIndicators(sortType, nsMsgViewSortOrder.ascending);
    return;
  }
  // null this out, so we don't try sort.
  if (gDBView) {
    gDBView.close();
    gDBView = null;
  }
  gDBView = Cc["@mozilla.org/messenger/msgdbview;1?type=group"]
                                .createInstance(Ci.nsIMsgDBView);

  if (!gThreadPaneCommandUpdater)
    gThreadPaneCommandUpdater = new nsMsgDBViewCommandUpdater();


  gDBView.init(messenger, msgWindow, gThreadPaneCommandUpdater);
  gDBView.open(msgFolder, sortType, sortOrder, viewFlags, count);
  RerootThreadPane();
  UpdateSortIndicators(sortType, nsMsgViewSortOrder.ascending);
  Services.obs.notifyObservers(msgFolder, "MsgCreateDBView",
      Ci.nsMsgViewType.eShowAllThreads + ":" + viewFlags);
}

function MsgSortUnthreaded()
{
    // Toggle if not already unthreaded.
    if ((GetDBView().viewFlags & nsMsgViewFlagsType.kThreadedDisplay) != 0)
        MsgToggleThreaded();
}

function MsgSortAscending()
{
  var dbview = GetDBView();
  dbview.sort(dbview.sortType, nsMsgViewSortOrder.ascending);
  UpdateSortIndicators(dbview.sortType, nsMsgViewSortOrder.ascending);
}

function MsgSortDescending()
{
  var dbview = GetDBView();
  dbview.sort(dbview.sortType, nsMsgViewSortOrder.descending);
  UpdateSortIndicators(dbview.sortType, nsMsgViewSortOrder.descending);
}

function groupedBySortUsingDummyRow()
{
  return (gDBView.viewFlags & nsMsgViewFlagsType.kGroupBySort) &&
         (gDBView.sortType != nsMsgViewSortType.bySubject);
}

function UpdateSortIndicators(sortType, sortOrder)
{
  // Remove the sort indicator from all the columns
  var treeColumns = document.getElementById('threadCols').childNodes;
  for (var i = 0; i < treeColumns.length; i++)
    treeColumns[i].removeAttribute('sortDirection');

  // show the twisties if the view is threaded
  var threadCol = document.getElementById("threadCol");
  var sortedColumn;
  // set the sort indicator on the column we are sorted by
  var colID = ConvertSortTypeToColumnID(sortType);
  if (colID)
    sortedColumn = document.getElementById(colID);

  var dbview = GetDBView();
  var currCol = dbview.viewFlags & nsMsgViewFlagsType.kGroupBySort
    ? sortedColumn : document.getElementById("subjectCol");

  if (dbview.viewFlags & nsMsgViewFlagsType.kGroupBySort)
  {
    var threadTree = document.getElementById("threadTree");
    var subjectCol = document.getElementById("subjectCol");

    if (groupedBySortUsingDummyRow())
    {
      currCol.removeAttribute("primary");
      subjectCol.setAttribute("primary", "true");
    }

    // hide the threaded column when in grouped view since you can't do
    // threads inside of a group.
    document.getElementById("threadCol").collapsed = true;
  }

  // clear primary attribute from group column if going to a non-grouped view.
  if (!(dbview.viewFlags & nsMsgViewFlagsType.kGroupBySort))
    document.getElementById("threadCol").collapsed = false;

  if ((dbview.viewFlags & nsMsgViewFlagsType.kThreadedDisplay) && !groupedBySortUsingDummyRow()) {
    threadCol.setAttribute("sortDirection", "ascending");
    currCol.setAttribute("primary", "true");
  }
  else {
    threadCol.removeAttribute("sortDirection");
    currCol.removeAttribute("primary");
  }

  if (sortedColumn) {
    if (sortOrder == nsMsgViewSortOrder.ascending) {
      sortedColumn.setAttribute("sortDirection","ascending");
    }
    else {
      sortedColumn.setAttribute("sortDirection","descending");
    }
  }
}

function IsSpecialFolderSelected(flags, checkAncestors)
{
  var folder = GetThreadPaneFolder();
  return folder && folder.isSpecialFolder(flags, checkAncestors);
}

function GetThreadTree()
{
  return document.getElementById("threadTree")
}

function GetThreadPaneFolder()
{
  try {
    return gDBView.msgFolder;
  }
  catch (ex) {
    return null;
  }
}

function EnsureRowInThreadTreeIsVisible(index)
{
  if (index < 0)
    return;

  var tree = GetThreadTree();
  tree.treeBoxObject.ensureRowIsVisible(index);
}

function RerootThreadPane()
{
  SetNewsFolderColumns();

  var treeView = gDBView.QueryInterface(Ci.nsITreeView);
  if (treeView)
  {
    var tree = GetThreadTree();
    tree.view = treeView;
  }
}

function ThreadPaneOnLoad()
{
  var tree = GetThreadTree();
  // We won't have the tree if we're in a message window, so exit silently
  if (!tree)
    return;

  tree.addEventListener("click",ThreadPaneOnClick,true);

  // The mousedown event listener below should only be added in the thread
  // pane of the mailnews 3pane window, not in the advanced search window.
  if(tree.parentNode.id == "searchResultListBox")
    return;

  tree.addEventListener("mousedown",TreeOnMouseDown,true);
  var delay = Services.prefs.getIntPref("mailnews.threadpane_select_delay");
  document.getElementById("threadTree")._selectDelay = delay;
}

function ThreadPaneSelectionChanged()
{
  UpdateStatusMessageCounts(gMsgFolderSelected);
  if (!gRightMouseButtonDown)
    GetThreadTree().view.selectionChanged();
}

var ThreadPaneDND = {
  onDragStart(aEvent) {
    if (aEvent.originalTarget.localName != "treechildren")
      return;

    let messageUris = gFolderDisplay.selectedMessageUris;
    if (!messageUris)
       return;

    // A message can be dragged from one window and dropped on another window.
    // Therefore we setNextMessageAfterDelete() here since there is no major
    // disadvantage, even if it is a copy operation.
    SetNextMessageAfterDelete();
    let messengerBundle = document.getElementById("bundle_messenger");
    let noSubject = messengerBundle.getString("defaultSaveMessageAsFileName");
    if (noSubject.endsWith(".eml")) {
      noSubject = noSubject.slice(0, -4);
    }
    let fileNames = [];
    let dataTransfer = aEvent.dataTransfer;

    for (let [index, msgUri] of messageUris.entries()) {
      let msgService = messenger.messageServiceFromURI(msgUri);
      let msgHdr = msgService.messageURIToMsgHdr(msgUri);
      let subject = msgHdr.mime2DecodedSubject || noSubject;
      if (msgHdr.flags & Ci.nsMsgMessageFlags.HasRe) {
        subject = "Re: " + subject;
      }
      let uniqueFileName = suggestUniqueFileName(subject.substr(0, 120), ".eml",
                                                 fileNames);
      fileNames[index] = uniqueFileName;
      let msgUrl = {};
      msgService.GetUrlForUri(msgUri, msgUrl, null);
      dataTransfer.mozSetDataAt("text/x-moz-message", msgUri, index);
      dataTransfer.mozSetDataAt("text/x-moz-url", msgUrl.value.spec, index);
      dataTransfer.mozSetDataAt("application/x-moz-file-promise-url",
                                 msgUrl.value.spec + "?fileName=" +
                                 encodeURIComponent(uniqueFileName),
                                 index);
      dataTransfer.mozSetDataAt("application/x-moz-file-promise",
                                new messageFlavorDataProvider(), index);
    }
    dataTransfer.effectAllowed = "copyMove";
    dataTransfer.addElement(aEvent.originalTarget);
  },

  onDragOver(aEvent) {
    if (!gMsgFolderSelected.canFileMessages ||
        gMsgFolderSelected.server.type == "rss")
      return;
    let dt = aEvent.dataTransfer;
    dt.effectAllowed = "copy";
    for (let i = 0; i < dt.mozItemCount; i++) {
      if (Array.from(dt.mozTypesAt(i)).includes("application/x-moz-file")) {
        let extFile = dt.mozGetDataAt("application/x-moz-file", i);
        if (!extFile) {
          return;
        }

        extFile = extFile.QueryInterface(Ci.nsIFile);
        if (extFile.isFile() && /\.eml$/i.test(extFile.leafName)) {
          aEvent.preventDefault();
          return;
        }
      }
    }
  },

  onDrop(aEvent) {
    let dt = aEvent.dataTransfer;
    for (let i = 0; i < dt.mozItemCount; i++) {
      let extFile = dt.mozGetDataAt("application/x-moz-file", i);
      if (!extFile) {
        continue;
      }

      extFile = extFile.QueryInterface(Ci.nsIFile);
      if (extFile.isFile() && /\.eml$/i.test(extFile.leafName))
        MailServices.copy.CopyFileMessage(extFile, gMsgFolderSelected, null,
                                          false, 1, "", null, msgWindow);
    }
  },
}

function messageFlavorDataProvider() {}

messageFlavorDataProvider.prototype = {
  QueryInterface: ChromeUtils.generateQI(["nsIFlavorDataProvider"]),

  getFlavorData(aTransferable, aFlavor, aData, aDataLen) {
    if (aFlavor !== "application/x-moz-file-promise") {
      return;
    }
    let fileUriPrimitive = {};
    let dataSize = {};
    aTransferable.getTransferData("application/x-moz-file-promise-url",
                                  fileUriPrimitive, dataSize);

    let fileUriStr = fileUriPrimitive.value
                                     .QueryInterface(Ci.nsISupportsString);
    let fileUri = Services.io.newURI(fileUriStr.data);
    let fileUrl = fileUri.QueryInterface(Ci.nsIURL);
    let fileName = fileUrl.fileName;

    let destDirPrimitive = {};
    aTransferable.getTransferData("application/x-moz-file-promise-dir",
                                  destDirPrimitive, dataSize);
    let destDirectory = destDirPrimitive.value.QueryInterface(Ci.nsIFile);
    let file = destDirectory.clone();
    file.append(fileName);

    let messageUriPrimitive = {};
    aTransferable.getTransferData("text/x-moz-message", messageUriPrimitive,
                                  dataSize);
    let messageUri = messageUriPrimitive.value
                                        .QueryInterface(Ci.nsISupportsString);

    messenger.saveAs(messageUri.data, true, null, decodeURIComponent(file.path),
                     true);
  },
};

addEventListener("load",ThreadPaneOnLoad,true);
