/* -*- indent-tabs-mode: nil; js-indent-level: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* import-globals-from editBookmarkOverlay.js */
/* import-globals-from ../../../../../toolkit/content/contentAreaUtils.js */

var { AppConstants } =
  ChromeUtils.import("resource://gre/modules/AppConstants.jsm");

ChromeUtils.defineModuleGetter(this, "MigrationUtils",
  "resource:///modules/MigrationUtils.jsm");
ChromeUtils.defineModuleGetter(this, "BookmarkJSONUtils",
  "resource://gre/modules/BookmarkJSONUtils.jsm");
ChromeUtils.defineModuleGetter(this, "PlacesBackups",
  "resource://gre/modules/PlacesBackups.jsm");
ChromeUtils.defineModuleGetter(this, "DownloadUtils",
  "resource://gre/modules/DownloadUtils.jsm");
ChromeUtils.defineModuleGetter(this, "OS",
  "resource://gre/modules/osfile.jsm");

const RESTORE_FILEPICKER_FILTER_EXT = "*.json;*.jsonlz4";

var PlacesOrganizer = {
  _places: null,

  // IDs of fields from editBookmarkOverlay that should be hidden when infoBox
  // is minimal. IDs should be kept in sync with the IDs of the elements
  // observing additionalInfoBroadcaster.
  _additionalInfoFields: [
    "editBMPanel_descriptionRow",
    "editBMPanel_loadInSidebarCheckbox",
    "editBMPanel_keywordRow",
  ],

  _initFolderTree() {
    var leftPaneRoot = PlacesUIUtils.leftPaneFolderId;
    this._places.place = "place:excludeItems=1&expandQueries=0&folder=" + leftPaneRoot;
  },

  /**
   * Selects a left pane built-in item.
   *
   * @param {String} item The built-in item to select, may be one of (case sensitive):
   *                      AllBookmarks, BookmarksMenu, BookmarksToolbar,
   *                      History, Tags, UnfiledBookmarks.
   */
  selectLeftPaneBuiltIn(item) {
    switch (item) {
      case "AllBookmarks":
      case "History":
      case "Tags": {
        var itemId = PlacesUIUtils.leftPaneQueries[item];
        this._places.selectItems([itemId]);
        // Forcefully expand all-bookmarks
        if (item == "AllBookmarks" || item == "History")
          PlacesUtils.asContainer(this._places.selectedNode).containerOpen = true;
        break;
      }
      case "BookmarksMenu":
        this.selectLeftPaneContainerByHierarchy([
          PlacesUIUtils.leftPaneQueries.AllBookmarks,
          PlacesUtils.bookmarks.virtualMenuGuid
        ]);
        break;
      case "BookmarksToolbar":
        this.selectLeftPaneContainerByHierarchy([
          PlacesUIUtils.leftPaneQueries.AllBookmarks,
          PlacesUtils.bookmarks.virtualToolbarGuid
        ]);
        break;
      case "UnfiledBookmarks":
        this.selectLeftPaneContainerByHierarchy([
          PlacesUIUtils.leftPaneQueries.AllBookmarks,
          PlacesUtils.bookmarks.virtualUnfiledGuid
        ]);
        break;
      default:
        throw new Error(`Unrecognized item ${item} passed to selectLeftPaneRootItem`);
    }
  },

  /**
   * Opens a given hierarchy in the left pane, stopping at the last reachable
   * container. Note: item ids should be considered deprecated.
   *
   * @param aHierarchy A single container or an array of containers, sorted from
   *                   the outmost to the innermost in the hierarchy. Each
   *                   container may be either an item id, a Places URI string,
   *                   or a named query, like:
   *                   "BookmarksMenu", "BookmarksToolbar", "UnfiledBookmarks", "AllBookmarks".
   * @see PlacesUIUtils.leftPaneQueries for supported named queries.
   */
  selectLeftPaneContainerByHierarchy(aHierarchy) {
    if (!aHierarchy)
      throw new Error("Containers hierarchy not specified");
    let hierarchy = [].concat(aHierarchy);
    let selectWasSuppressed = this._places.view.selection.selectEventsSuppressed;
    if (!selectWasSuppressed)
      this._places.view.selection.selectEventsSuppressed = true;
    try {
      for (let container of hierarchy) {
        switch (typeof container) {
          case "number":
            this._places.selectItems([container], false);
            break;
          case "string":
            try {
              this.selectLeftPaneBuiltIn(container);
            } catch (ex) {
              if (container.substr(0, 6) == "place:") {
                this._places.selectPlaceURI(container);
              } else {
                // May be a guid.
                this._places.selectItems([container], false);
              }
            }
            break;
          default:
            throw new Error("Invalid container type found: " + container);
        }
        PlacesUtils.asContainer(this._places.selectedNode).containerOpen = true;
      }
    } finally {
      if (!selectWasSuppressed)
        this._places.view.selection.selectEventsSuppressed = false;
    }
  },

  init: function PO_init() {
    ContentArea.init();

    this._places = document.getElementById("placesList");
    this._initFolderTree();

    var leftPaneSelection = "AllBookmarks"; // default to all-bookmarks
    if (window.arguments && window.arguments[0])
      leftPaneSelection = window.arguments[0];

    this.selectLeftPaneContainerByHierarchy(leftPaneSelection);
    if (leftPaneSelection === "History") {
      let historyNode = this._places.selectedNode;
      if (historyNode.childCount > 0)
        this._places.selectNode(historyNode.getChild(0));
    }

    // clear the back-stack
    this._backHistory.splice(0, this._backHistory.length);
    document.getElementById("OrganizerCommand:Back").setAttribute("disabled", true);

    // Set up the search UI.
    PlacesSearchBox.init();

    window.addEventListener("AppCommand", this, true);

    // remove the "Properties" context-menu item, we've our own details pane
    document.getElementById("placesContext")
            .removeChild(document.getElementById("placesContext_show:info"));

    ContentArea.focus();
  },

  QueryInterface: ChromeUtils.generateQI([]),

  handleEvent: function PO_handleEvent(aEvent) {
    if (aEvent.type != "AppCommand")
      return;

    aEvent.stopPropagation();
    switch (aEvent.command) {
      case "Back":
        if (this._backHistory.length > 0)
          this.back();
        break;
      case "Forward":
        if (this._forwardHistory.length > 0)
          this.forward();
        break;
      case "Search":
        PlacesSearchBox.findAll();
        break;
    }
  },

  destroy: function PO_destroy() {
  },

  _location: null,
  get location() {
    return this._location;
  },

  set location(aLocation) {
    if (!aLocation || this._location == aLocation)
      return aLocation;

    if (this.location) {
      this._backHistory.unshift(this.location);
      this._forwardHistory.splice(0, this._forwardHistory.length);
    }

    this._location = aLocation;
    this._places.selectPlaceURI(aLocation);

    if (!this._places.hasSelection) {
      // If no node was found for the given place: uri, just load it directly
      ContentArea.currentPlace = aLocation;
    }
    this.updateDetailsPane();

    // update navigation commands
    if (this._backHistory.length == 0)
      document.getElementById("OrganizerCommand:Back").setAttribute("disabled", true);
    else
      document.getElementById("OrganizerCommand:Back").removeAttribute("disabled");
    if (this._forwardHistory.length == 0)
      document.getElementById("OrganizerCommand:Forward").setAttribute("disabled", true);
    else
      document.getElementById("OrganizerCommand:Forward").removeAttribute("disabled");

    return aLocation;
  },

  _backHistory: [],
  _forwardHistory: [],

  back: function PO_back() {
    this._forwardHistory.unshift(this.location);
    var historyEntry = this._backHistory.shift();
    this._location = null;
    this.location = historyEntry;
  },
  forward: function PO_forward() {
    this._backHistory.unshift(this.location);
    var historyEntry = this._forwardHistory.shift();
    this._location = null;
    this.location = historyEntry;
  },

  /**
   * Called when a place folder is selected in the left pane.
   * @param   resetSearchBox
   *          true if the search box should also be reset, false otherwise.
   *          The search box should be reset when a new folder in the left
   *          pane is selected; the search scope and text need to be cleared in
   *          preparation for the new folder.  Note that if the user manually
   *          resets the search box, either by clicking its reset button or by
   *          deleting its text, this will be false.
   */
  _cachedLeftPaneSelectedURI: null,
  onPlaceSelected: function PO_onPlaceSelected(resetSearchBox) {
    // Don't change the right-hand pane contents when there's no selection.
    if (!this._places.hasSelection)
      return;

    let node = this._places.selectedNode;
    let placeURI = node.uri;

    // If either the place of the content tree in the right pane has changed or
    // the user cleared the search box, update the place, hide the search UI,
    // and update the back/forward buttons by setting location.
    if (ContentArea.currentPlace != placeURI || !resetSearchBox) {
      ContentArea.currentPlace = placeURI;
      this.location = placeURI;
    }

    // When we invalidate a container we use suppressSelectionEvent, when it is
    // unset a select event is fired, in many cases the selection did not really
    // change, so we should check for it, and return early in such a case. Note
    // that we cannot return any earlier than this point, because when
    // !resetSearchBox, we need to update location and hide the UI as above,
    // even though the selection has not changed.
    if (placeURI == this._cachedLeftPaneSelectedURI)
      return;
    this._cachedLeftPaneSelectedURI = placeURI;

    // At this point, resetSearchBox is true, because the left pane selection
    // has changed; otherwise we would have returned earlier.

    PlacesSearchBox.searchFilter.reset();
    this._setSearchScopeForNode(node);
    this.updateDetailsPane();
  },

  /**
   * Sets the search scope based on aNode's properties.
   * @param   aNode
   *          the node to set up scope from
   */
  _setSearchScopeForNode: function PO__setScopeForNode(aNode) {
    let itemId = aNode.itemId;

    if (PlacesUtils.nodeIsHistoryContainer(aNode) ||
        itemId == PlacesUIUtils.leftPaneQueries.History) {
      PlacesQueryBuilder.setScope("history");
    } else {
      // Default to All Bookmarks for all other nodes, per bug 469437.
      PlacesQueryBuilder.setScope("bookmarks");
    }
  },

  /**
   * Handle clicks on the places list.
   * Single Left click, right click or modified click do not result in any
   * special action, since they're related to selection.
   * @param   aEvent
   *          The mouse event.
   */
  onPlacesListClick: function PO_onPlacesListClick(aEvent) {
    // Only handle clicks on tree children.
    if (aEvent.target.localName != "treechildren")
      return;

    let node = this._places.selectedNode;
    if (node) {
      let middleClick = aEvent.button == 1 && aEvent.detail == 1;
      if (middleClick && PlacesUtils.nodeIsContainer(node)) {
        // The command execution function will take care of seeing if the
        // selection is a folder or a different container type, and will
        // load its contents in tabs.
        PlacesUIUtils.openContainerNodeInTabs(node, aEvent, this._places);
      }
    }
  },

  /**
   * Handle focus changes on the places list and the current content view.
   */
  updateDetailsPane: function PO_updateDetailsPane() {
    if (!ContentArea.currentViewOptions.showDetailsPane)
      return;
    let view = PlacesUIUtils.getViewForNode(document.activeElement);
    if (view) {
      let selectedNodes = view.selectedNode ?
                          [view.selectedNode] : view.selectedNodes;
      this._fillDetailsPane(selectedNodes);
    }
  },

  openFlatContainer: function PO_openFlatContainerFlatContainer(aContainer) {
    if (aContainer.itemId != -1) {
      PlacesUtils.asContainer(this._places.selectedNode).containerOpen = true;
      this._places.selectItems([aContainer.itemId], false);
    } else if (PlacesUtils.nodeIsQuery(aContainer)) {
      this._places.selectPlaceURI(aContainer.uri);
    }
  },

  /**
   * Returns the options associated with the query currently loaded in the
   * main places pane.
   */
  getCurrentOptions: function PO_getCurrentOptions() {
    return PlacesUtils.asQuery(ContentArea.currentView.result.root).queryOptions;
  },

  /**
   * Returns the queries associated with the query currently loaded in the
   * main places pane.
   */
  getCurrentQueries: function PO_getCurrentQueries() {
    return PlacesUtils.asQuery(ContentArea.currentView.result.root).getQueries();
  },

  /**
   * Show the migration wizard for importing passwords,
   * cookies, history, preferences, and bookmarks.
   */
  importFromBrowser: function PO_importFromBrowser() {
    // We pass in the type of source we're using for future use:
    MigrationUtils.showMigrationWizard(window, [MigrationUtils.MIGRATION_ENTRYPOINT_PLACES]);
  },

  /**
   * Open a file-picker and import the selected file into the bookmarks store
   */
  importFromFile: function PO_importFromFile() {
    let fp = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
    let fpCallback = function fpCallback_done(aResult) {
      if (aResult != Ci.nsIFilePicker.returnCancel && fp.fileURL) {
        var {BookmarkHTMLUtils} = ChromeUtils.import("resource://gre/modules/BookmarkHTMLUtils.jsm");
        BookmarkHTMLUtils.importFromURL(fp.fileURL.spec, false)
                         .catch(Cu.reportError);
      }
    };

    fp.init(window, PlacesUIUtils.getString("SelectImport"),
            Ci.nsIFilePicker.modeOpen);
    fp.appendFilters(Ci.nsIFilePicker.filterHTML);
    fp.open(fpCallback);
  },

  /**
   * Allows simple exporting of bookmarks.
   */
  exportBookmarks: function PO_exportBookmarks() {
    let fp = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
    let fpCallback = function fpCallback_done(aResult) {
      if (aResult != Ci.nsIFilePicker.returnCancel) {
        var {BookmarkHTMLUtils} = ChromeUtils.import("resource://gre/modules/BookmarkHTMLUtils.jsm");
        BookmarkHTMLUtils.exportToFile(fp.file.path)
                         .catch(Cu.reportError);
      }
    };

    fp.init(window, PlacesUIUtils.getString("EnterExport"),
            Ci.nsIFilePicker.modeSave);
    fp.appendFilters(Ci.nsIFilePicker.filterHTML);
    fp.defaultString = "bookmarks.html";
    fp.open(fpCallback);
  },

  /**
   * Populates the restore menu with the dates of the backups available.
   */
  populateRestoreMenu: function PO_populateRestoreMenu() {
    let restorePopup = document.getElementById("fileRestorePopup");

    const dtOptions = {
      dateStyle: "long"
    };
    let dateFormatter = new Services.intl.DateTimeFormat(undefined, dtOptions);

    // Remove existing menu items.  Last item is the restoreFromFile item.
    while (restorePopup.childNodes.length > 1)
      restorePopup.firstChild.remove();

    (async function() {
      let backupFiles = await PlacesBackups.getBackupFiles();
      if (backupFiles.length == 0)
        return;

      // Populate menu with backups.
      for (let i = 0; i < backupFiles.length; i++) {
        let fileSize = (await OS.File.stat(backupFiles[i])).size;
        let [size, unit] = DownloadUtils.convertByteUnits(fileSize);
        let sizeString = PlacesUtils.getFormattedString("backupFileSizeText",
                                                        [size, unit]);
        let sizeInfo;
        let bookmarkCount = PlacesBackups.getBookmarkCountForFile(backupFiles[i]);
        if (bookmarkCount != null) {
          sizeInfo = " (" + sizeString + " - " +
                     PlacesUIUtils.getPluralString("detailsPane.itemsCountLabel",
                                                   bookmarkCount,
                                                   [bookmarkCount]) +
                     ")";
        } else {
          sizeInfo = " (" + sizeString + ")";
        }

        let backupDate = PlacesBackups.getDateForFile(backupFiles[i]);
        let m = restorePopup.insertBefore(document.createElement("menuitem"),
                                          document.getElementById("restoreFromFile"));
        m.setAttribute("label", dateFormatter.format(backupDate) + sizeInfo);
        m.setAttribute("value", OS.Path.basename(backupFiles[i]));
        m.setAttribute("oncommand",
                       "PlacesOrganizer.onRestoreMenuItemClick(this);");
      }

      // Add the restoreFromFile item.
      restorePopup.insertBefore(document.createElement("menuseparator"),
                                document.getElementById("restoreFromFile"));
    })();
  },

  /**
   * Called when a menuitem is selected from the restore menu.
   */
  async onRestoreMenuItemClick(aMenuItem) {
    let backupName = aMenuItem.getAttribute("value");
    let backupFilePaths = await PlacesBackups.getBackupFiles();
    for (let backupFilePath of backupFilePaths) {
      if (OS.Path.basename(backupFilePath) == backupName) {
        PlacesOrganizer.restoreBookmarksFromFile(backupFilePath);
        break;
      }
    }
  },

  /**
   * Called when 'Choose File...' is selected from the restore menu.
   * Prompts for a file and restores bookmarks to those in the file.
   */
  onRestoreBookmarksFromFile: function PO_onRestoreBookmarksFromFile() {
    let backupsDir = Services.dirsvc.get("Desk", Ci.nsIFile);
    let fp = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
    let fpCallback = aResult => {
      if (aResult != Ci.nsIFilePicker.returnCancel) {
        this.restoreBookmarksFromFile(fp.file.path);
      }
    };

    fp.init(window, PlacesUIUtils.getString("bookmarksRestoreTitle"),
            Ci.nsIFilePicker.modeOpen);
    fp.appendFilter(PlacesUIUtils.getString("bookmarksRestoreFilterName"),
                    RESTORE_FILEPICKER_FILTER_EXT);
    fp.appendFilters(Ci.nsIFilePicker.filterAll);
    fp.displayDirectory = backupsDir;
    fp.open(fpCallback);
  },

  /**
   * Restores bookmarks from a JSON file.
   */
  restoreBookmarksFromFile: function PO_restoreBookmarksFromFile(aFilePath) {
    // check file extension
    if (!aFilePath.toLowerCase().endsWith("json") &&
        !aFilePath.toLowerCase().endsWith("jsonlz4")) {
      this._showErrorAlert(PlacesUIUtils.getString("bookmarksRestoreFormatError"));
      return;
    }

    // confirm ok to delete existing bookmarks
    if (!Services.prompt.confirm(null,
           PlacesUIUtils.getString("bookmarksRestoreAlertTitle"),
           PlacesUIUtils.getString("bookmarksRestoreAlert")))
      return;

    (async function() {
      try {
        await BookmarkJSONUtils.importFromFile(aFilePath, true);
      } catch (ex) {
        PlacesOrganizer._showErrorAlert(PlacesUIUtils.getString("bookmarksRestoreParseError"));
      }
    })();
  },

  _showErrorAlert: function PO__showErrorAlert(aMsg) {
    var brandShortName = document.getElementById("brandStrings").
                                  getString("brandShortName");

    Services.prompt.alert(window, brandShortName, aMsg);
  },

  /**
   * Backup bookmarks to desktop, auto-generate a filename with a date.
   * The file is a JSON serialization of bookmarks, tags and any annotations
   * of those items.
   */
  backupBookmarks: function PO_backupBookmarks() {
    let backupsDir = Services.dirsvc.get("Desk", Ci.nsIFile);
    let fp = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
    let fpCallback = function fpCallback_done(aResult) {
      if (aResult != Ci.nsIFilePicker.returnCancel) {
        // There is no OS.File version of the filepicker yet (Bug 937812).
        PlacesBackups.saveBookmarksToJSONFile(fp.file.path)
                     .catch(Cu.reportError);
      }
    };

    fp.init(window, PlacesUIUtils.getString("bookmarksBackupTitle"),
            Ci.nsIFilePicker.modeSave);
    fp.appendFilter(PlacesUIUtils.getString("bookmarksRestoreFilterName"),
                    RESTORE_FILEPICKER_FILTER_EXT);
    fp.defaultString = PlacesBackups.getFilenameForDate();
    fp.defaultExtension = "json";
    fp.displayDirectory = backupsDir;
    fp.open(fpCallback);
  },

  _detectAndSetDetailsPaneMinimalState:
  function PO__detectAndSetDetailsPaneMinimalState(aNode) {
    /**
     * The details of simple folder-items (as opposed to livemarks) or the
     * of livemark-children are not likely to fill the infoBox anyway,
     * thus we remove the "More/Less" button and show all details.
     *
     * the wasminimal attribute here is used to persist the "more/less"
     * state in a bookmark->folder->bookmark scenario.
     */
    var infoBox = document.getElementById("infoBox");
    var infoBoxExpanderWrapper = document.getElementById("infoBoxExpanderWrapper");
    var additionalInfoBroadcaster = document.getElementById("additionalInfoBroadcaster");

    if (!aNode) {
      infoBoxExpanderWrapper.hidden = true;
      return;
    }
    if (aNode.itemId != -1 &&
        PlacesUtils.nodeIsFolder(aNode) && !aNode._feedURI) {
      if (infoBox.getAttribute("minimal") == "true")
        infoBox.setAttribute("wasminimal", "true");
      infoBox.removeAttribute("minimal");
      infoBoxExpanderWrapper.hidden = true;
    } else {
      if (infoBox.getAttribute("wasminimal") == "true")
        infoBox.setAttribute("minimal", "true");
      infoBox.removeAttribute("wasminimal");
      infoBoxExpanderWrapper.hidden =
        this._additionalInfoFields.every(id =>
          document.getElementById(id).collapsed);
    }
    additionalInfoBroadcaster.hidden = infoBox.getAttribute("minimal") == "true";
  },

  // NOT YET USED
  updateThumbnailProportions: function PO_updateThumbnailProportions() {
    var previewBox = document.getElementById("previewBox");
    var canvas = document.getElementById("itemThumbnail");
    var height = previewBox.boxObject.height;
    var width = height * (screen.width / screen.height);
    canvas.width = width;
    canvas.height = height;
  },

  _fillDetailsPane: function PO__fillDetailsPane(aNodeList) {
    var infoBox = document.getElementById("infoBox");
    var detailsDeck = document.getElementById("detailsDeck");

    // Make sure the infoBox UI is visible if we need to use it, we hide it
    // below when we don't.
    infoBox.hidden = false;
    let selectedNode = aNodeList.length == 1 ? aNodeList[0] : null;

    // If a textbox within a panel is focused, force-blur it so its contents
    // are saved
    if (gEditItemOverlay.itemId != -1) {
      var focusedElement = document.commandDispatcher.focusedElement;
      if ((focusedElement instanceof HTMLInputElement ||
           focusedElement instanceof HTMLTextAreaElement) &&
          /^editBMPanel.*/.test(focusedElement.parentNode.parentNode.id))
        focusedElement.blur();

      // don't update the panel if we are already editing this node unless we're
      // in multi-edit mode
      if (selectedNode) {
        let concreteId = PlacesUtils.getConcreteItemId(selectedNode);
        var nodeIsSame = gEditItemOverlay.itemId == selectedNode.itemId ||
                         gEditItemOverlay.itemId == concreteId ||
                         (selectedNode.itemId == -1 && gEditItemOverlay.uri &&
                          gEditItemOverlay.uri == selectedNode.uri);
        if (nodeIsSame && detailsDeck.selectedIndex == 1 &&
            !gEditItemOverlay.multiEdit)
          return;
      }
    }

    // Clean up the panel before initing it again.
    gEditItemOverlay.uninitPanel(false);

    if (selectedNode && !PlacesUtils.nodeIsSeparator(selectedNode)) {
      detailsDeck.selectedIndex = 1;

      gEditItemOverlay.initPanel({ node: selectedNode,
                                   hiddenRows: ["folderPicker"] });

      this._detectAndSetDetailsPaneMinimalState(selectedNode);
    } else if (!selectedNode && aNodeList[0]) {
      if (aNodeList.every(PlacesUtils.nodeIsURI)) {
        let uris = aNodeList.map(node => Services.io.newURI(node.uri));
        detailsDeck.selectedIndex = 1;
        gEditItemOverlay.initPanel({ uris,
                                     hiddenRows: ["folderPicker",
                                                  "loadInSidebar",
                                                  "location",
                                                  "keyword",
                                                  "description",
                                                  "name"]});
        this._detectAndSetDetailsPaneMinimalState(selectedNode);
      } else {
        detailsDeck.selectedIndex = 0;
        let selectItemDesc = document.getElementById("selectItemDescription");
        let itemsCountLabel = document.getElementById("itemsCountText");
        selectItemDesc.hidden = false;
        itemsCountLabel.value =
          PlacesUIUtils.getPluralString("detailsPane.itemsCountLabel",
                                        aNodeList.length, [aNodeList.length]);
        infoBox.hidden = true;
      }
    } else {
      detailsDeck.selectedIndex = 0;
      infoBox.hidden = true;
      let selectItemDesc = document.getElementById("selectItemDescription");
      let itemsCountLabel = document.getElementById("itemsCountText");
      let itemsCount = 0;
      if (ContentArea.currentView.result) {
        let rootNode = ContentArea.currentView.result.root;
        if (rootNode.containerOpen)
          itemsCount = rootNode.childCount;
      }
      if (itemsCount == 0) {
        selectItemDesc.hidden = true;
        itemsCountLabel.value = PlacesUIUtils.getString("detailsPane.noItems");
      } else {
        selectItemDesc.hidden = false;
        itemsCountLabel.value =
          PlacesUIUtils.getPluralString("detailsPane.itemsCountLabel",
                                        itemsCount, [itemsCount]);
      }
    }
  },

  // NOT YET USED
  _updateThumbnail: function PO__updateThumbnail() {
    var bo = document.getElementById("previewBox").boxObject;
    var width  = bo.width;
    var height = bo.height;

    var canvas = document.getElementById("itemThumbnail");
    var ctx = canvas.getContext("2d");
    var notAvailableText = canvas.getAttribute("notavailabletext");
    ctx.save();
    ctx.fillStyle = "-moz-Dialog";
    ctx.fillRect(0, 0, width, height);
    ctx.translate(width / 2, height / 2);

    ctx.fillStyle = "GrayText";
    ctx.mozTextStyle = "12pt sans serif";
    var len = ctx.mozMeasureText(notAvailableText);
    ctx.translate(-len / 2, 0);
    ctx.mozDrawText(notAvailableText);
    ctx.restore();
  },

  toggleAdditionalInfoFields: function PO_toggleAdditionalInfoFields() {
    var infoBox = document.getElementById("infoBox");
    var infoBoxExpander = document.getElementById("infoBoxExpander");
    var infoBoxExpanderLabel = document.getElementById("infoBoxExpanderLabel");
    var additionalInfoBroadcaster = document.getElementById("additionalInfoBroadcaster");

    if (infoBox.getAttribute("minimal") == "true") {
      infoBox.removeAttribute("minimal");
      infoBoxExpanderLabel.value = infoBoxExpanderLabel.getAttribute("lesslabel");
      infoBoxExpanderLabel.accessKey = infoBoxExpanderLabel.getAttribute("lessaccesskey");
      infoBoxExpander.className = "expander-up";
      additionalInfoBroadcaster.removeAttribute("hidden");
    } else {
      infoBox.setAttribute("minimal", "true");
      infoBoxExpanderLabel.value = infoBoxExpanderLabel.getAttribute("morelabel");
      infoBoxExpanderLabel.accessKey = infoBoxExpanderLabel.getAttribute("moreaccesskey");
      infoBoxExpander.className = "expander-down";
      additionalInfoBroadcaster.setAttribute("hidden", "true");
    }
  },
};

/**
 * A set of utilities relating to search within Bookmarks and History.
 */
var PlacesSearchBox = {

  /**
   * The Search text field
   */
  get searchFilter() {
    return document.getElementById("searchFilter");
  },

  /**
   * Folders to include when searching.
   */
  _folders: [],
  get folders() {
    if (this._folders.length == 0) {
      this._folders.push(PlacesUtils.bookmarksMenuFolderId,
                         PlacesUtils.unfiledBookmarksFolderId,
                         PlacesUtils.toolbarFolderId,
                         PlacesUtils.mobileFolderId);
    }
    return this._folders;
  },
  set folders(aFolders) {
    this._folders = aFolders;
    return aFolders;
  },

  /**
   * Run a search for the specified text, over the collection specified by
   * the dropdown arrow. The default is all bookmarks, but can be
   * localized to the active collection.
   * @param   filterString
   *          The text to search for.
   */
  search: function PSB_search(filterString) {
    var PO = PlacesOrganizer;
    // If the user empties the search box manually, reset it and load all
    // contents of the current scope.
    // XXX this might be to jumpy, maybe should search for "", so results
    // are ungrouped, and search box not reset
    if (filterString == "") {
      PO.onPlaceSelected(false);
      return;
    }

    let currentView = ContentArea.currentView;

    // Search according to the current scope, which was set by
    // PQB_setScope()
    switch (PlacesSearchBox.filterCollection) {
      case "bookmarks":
        currentView.applyFilter(filterString, this.folders);
        break;
      case "history": {
        let currentOptions = PO.getCurrentOptions();
        if (currentOptions.queryType != Ci.nsINavHistoryQueryOptions.QUERY_TYPE_HISTORY) {
          let query = PlacesUtils.history.getNewQuery();
          query.searchTerms = filterString;
          let options = currentOptions.clone();
          // Make sure we're getting uri results.
          options.resultType = currentOptions.RESULTS_AS_URI;
          options.queryType = Ci.nsINavHistoryQueryOptions.QUERY_TYPE_HISTORY;
          options.includeHidden = true;
          currentView.load([query], options);
        } else {
          currentView.applyFilter(filterString, null, true);
        }
        break;
      }
      default:
        throw "Invalid filterCollection on search";
    }

    // Update the details panel
    PlacesOrganizer.updateDetailsPane();
  },

  /**
   * Finds across all history or all bookmarks.
   */
  findAll: function PSB_findAll() {
    switch (this.filterCollection) {
      case "history":
        PlacesQueryBuilder.setScope("history");
        break;
      default:
        PlacesQueryBuilder.setScope("bookmarks");
        break;
    }
    this.focus();
  },

  /**
   * Updates the display with the title of the current collection.
   * @param   aTitle
   *          The title of the current collection.
   */
  updateCollectionTitle: function PSB_updateCollectionTitle(aTitle) {
    let title = "";
    switch (this.filterCollection) {
      case "history":
        title = PlacesUIUtils.getString("searchHistory");
        break;
      default:
        title = PlacesUIUtils.getString("searchBookmarks");
    }
    this.searchFilter.placeholder = title;
  },

  /**
   * Gets/sets the active collection from the dropdown menu.
   */
  get filterCollection() {
    return this.searchFilter.getAttribute("collection");
  },
  set filterCollection(collectionName) {
    if (collectionName == this.filterCollection)
      return collectionName;

    this.searchFilter.setAttribute("collection", collectionName);
    this.updateCollectionTitle();

    return collectionName;
  },

  /**
   * Focus the search box
   */
  focus: function PSB_focus() {
    this.searchFilter.focus();
  },

  /**
   * Set up the gray text in the search bar as the Places View loads.
   */
  init: function PSB_init() {
    if (Services.prefs.getBoolPref("browser.urlbar.clickSelectsAll", false)) {
      this.searchFilter.setAttribute("clickSelectsAll", true);
    }
    this.updateCollectionTitle();
  },

  /**
   * Gets or sets the text shown in the Places Search Box
   */
  get value() {
    return this.searchFilter.value;
  },
  set value(value) {
    return this.searchFilter.value = value;
  },
};

/**
 * Functions and data for advanced query builder
 */
var PlacesQueryBuilder = {

  queries: [],
  queryOptions: null,

  /**
   * Sets the search scope.  This can be called when no search is active, and
   * in that case, when the user does begin a search aScope will be used (see
   * PSB_search()).  If there is an active search, it's performed again to
   * update the content tree.
   * @param   aScope
   *          The search scope: "bookmarks", "collection" or "history".
   */
  setScope: function PQB_setScope(aScope) {
    // Determine filterCollection, folders, and scopeButtonId based on aScope.
    var filterCollection;
    var folders = [];
    switch (aScope) {
      case "history":
        filterCollection = "history";
        break;
      case "bookmarks":
        filterCollection = "bookmarks";
        folders.push(PlacesUtils.bookmarksMenuFolderId,
                     PlacesUtils.toolbarFolderId,
                     PlacesUtils.unfiledBookmarksFolderId,
                     PlacesUtils.mobileFolderId);
        break;
      default:
        throw "Invalid search scope";
    }

    // Update the search box.  Re-search if there's an active search.
    PlacesSearchBox.filterCollection = filterCollection;
    PlacesSearchBox.folders = folders;
    var searchStr = PlacesSearchBox.searchFilter.value;
    if (searchStr)
      PlacesSearchBox.search(searchStr);
  }
};

/**
 * Population and commands for the View Menu.
 */
var ViewMenu = {
  /**
   * Removes content generated previously from a menupopup.
   * @param   popup
   *          The popup that contains the previously generated content.
   * @param   startID
   *          The id attribute of an element that is the start of the
   *          dynamically generated region - remove elements after this
   *          item only.
   *          Must be contained by popup. Can be null (in which case the
   *          contents of popup are removed).
   * @param   endID
   *          The id attribute of an element that is the end of the
   *          dynamically generated region - remove elements up to this
   *          item only.
   *          Must be contained by popup. Can be null (in which case all
   *          items until the end of the popup will be removed). Ignored
   *          if startID is null.
   * @returns The element for the caller to insert new items before,
   *          null if the caller should just append to the popup.
   */
  _clean: function VM__clean(popup, startID, endID) {
    if (endID && !startID)
      throw new Error("meaningless to have valid endID and null startID");
    if (startID) {
      var startElement = document.getElementById(startID);
      if (!startElement)
        throw new Error("startID does not correspond to an existing element");
      if (startElement.parentNode != popup)
        throw new Error("startElement is not in popup");
      var endElement = null;
      if (endID) {
        endElement = document.getElementById(endID);
        if (!endElement)
          throw new Error("endID does not correspond to an existing element");
        if (endElement.parentNode != popup)
          throw new Error("endElement is not in popup");
      }
      while (startElement.nextSibling != endElement)
        popup.removeChild(startElement.nextSibling);
      return endElement;
    }
    while (popup.hasChildNodes()) {
      popup.firstChild.remove();
    }
    return null;
  },

  /**
   * Fills a menupopup with a list of columns
   * @param   event
   *          The popupshowing event that invoked this function.
   * @param   startID
   *          see _clean
   * @param   endID
   *          see _clean
   * @param   type
   *          the type of the menuitem, e.g. "radio" or "checkbox".
   *          Can be null (no-type).
   *          Checkboxes are checked if the column is visible.
   * @param   propertyPrefix
   *          If propertyPrefix is non-null:
   *          propertyPrefix + column ID + ".label" will be used to get the
   *          localized label string.
   *          propertyPrefix + column ID + ".accesskey" will be used to get the
   *          localized accesskey.
   *          If propertyPrefix is null, the column label is used as label and
   *          no accesskey is assigned.
   */
  fillWithColumns: function VM_fillWithColumns(event, startID, endID, type, propertyPrefix) {
    var popup = event.target;
    var pivot = this._clean(popup, startID, endID);

    var content = document.getElementById("placeContent");
    var columns = content.columns;
    for (var i = 0; i < columns.count; ++i) {
      var column = columns.getColumnAt(i).element;
      var menuitem = document.createElement("menuitem");
      menuitem.id = "menucol_" + column.id;
      menuitem.column = column;
      var label = column.getAttribute("label");
      if (propertyPrefix) {
        var menuitemPrefix = propertyPrefix;
        // for string properties, use "name" as the id, instead of "title"
        // see bug #386287 for details
        var columnId = column.getAttribute("anonid");
        menuitemPrefix += columnId == "title" ? "name" : columnId;
        label = PlacesUIUtils.getString(menuitemPrefix + ".label");
        var accesskey = PlacesUIUtils.getString(menuitemPrefix + ".accesskey");
        menuitem.setAttribute("accesskey", accesskey);
      }
      menuitem.setAttribute("label", label);
      if (type == "radio") {
        menuitem.setAttribute("type", "radio");
        menuitem.setAttribute("name", "columns");
        // This column is the sort key. Its item is checked.
        if (column.getAttribute("sortDirection") != "") {
          menuitem.setAttribute("checked", "true");
        }
      } else if (type == "checkbox") {
        menuitem.setAttribute("type", "checkbox");
        // Cannot uncheck the primary column.
        if (column.getAttribute("primary") == "true")
          menuitem.setAttribute("disabled", "true");
        // Items for visible columns are checked.
        if (!column.hidden)
          menuitem.setAttribute("checked", "true");
      }
      if (pivot)
        popup.insertBefore(menuitem, pivot);
      else
        popup.appendChild(menuitem);
    }
    event.stopPropagation();
  },

  /**
   * Set up the content of the view menu.
   */
  populateSortMenu: function VM_populateSortMenu(event) {
    this.fillWithColumns(event, "viewUnsorted", "directionSeparator", "radio", "view.sortBy.1.");

    var sortColumn = this._getSortColumn();
    var viewSortAscending = document.getElementById("viewSortAscending");
    var viewSortDescending = document.getElementById("viewSortDescending");
    // We need to remove an existing checked attribute because the unsorted
    // menu item is not rebuilt every time we open the menu like the others.
    var viewUnsorted = document.getElementById("viewUnsorted");
    if (!sortColumn) {
      viewSortAscending.removeAttribute("checked");
      viewSortDescending.removeAttribute("checked");
      viewUnsorted.setAttribute("checked", "true");
    } else if (sortColumn.getAttribute("sortDirection") == "ascending") {
      viewSortAscending.setAttribute("checked", "true");
      viewSortDescending.removeAttribute("checked");
      viewUnsorted.removeAttribute("checked");
    } else if (sortColumn.getAttribute("sortDirection") == "descending") {
      viewSortDescending.setAttribute("checked", "true");
      viewSortAscending.removeAttribute("checked");
      viewUnsorted.removeAttribute("checked");
    }
  },

  /**
   * Shows/Hides a tree column.
   * @param   element
   *          The menuitem element for the column
   */
  showHideColumn: function VM_showHideColumn(element) {
    var column = element.column;

    var splitter = column.nextSibling;
    if (splitter && splitter.localName != "splitter")
      splitter = null;

    if (element.getAttribute("checked") == "true") {
      column.setAttribute("hidden", "false");
      if (splitter)
        splitter.removeAttribute("hidden");
    } else {
      column.setAttribute("hidden", "true");
      if (splitter)
        splitter.setAttribute("hidden", "true");
    }
  },

  /**
   * Gets the last column that was sorted.
   * @returns  the currently sorted column, null if there is no sorted column.
   */
  _getSortColumn: function VM__getSortColumn() {
    var content = document.getElementById("placeContent");
    var cols = content.columns;
    for (var i = 0; i < cols.count; ++i) {
      var column = cols.getColumnAt(i).element;
      var sortDirection = column.getAttribute("sortDirection");
      if (sortDirection == "ascending" || sortDirection == "descending")
        return column;
    }
    return null;
  },

  /**
   * Sorts the view by the specified column.
   * @param   aColumn
   *          The colum that is the sort key. Can be null - the
   *          current sort column or the title column will be used.
   * @param   aDirection
   *          The direction to sort - "ascending" or "descending".
   *          Can be null - the last direction or descending will be used.
   *
   * If both aColumnID and aDirection are null, the view will be unsorted.
   */
  setSortColumn: function VM_setSortColumn(aColumn, aDirection) {
    var result = document.getElementById("placeContent").result;
    if (!aColumn && !aDirection) {
      result.sortingMode = Ci.nsINavHistoryQueryOptions.SORT_BY_NONE;
      return;
    }

    var columnId;
    if (aColumn) {
      columnId = aColumn.getAttribute("anonid");
      if (!aDirection) {
        let sortColumn = this._getSortColumn();
        if (sortColumn)
          aDirection = sortColumn.getAttribute("sortDirection");
      }
    } else {
      let sortColumn = this._getSortColumn();
      columnId = sortColumn ? sortColumn.getAttribute("anonid") : "title";
    }

    // This maps the possible values of columnId (i.e., anonid's of treecols in
    // placeContent) to the default sortingMode and sortingAnnotation values for
    // each column.
    //   key:  Sort key in the name of one of the
    //         nsINavHistoryQueryOptions.SORT_BY_* constants
    //   dir:  Default sort direction to use if none has been specified
    //   anno: The annotation to sort by, if key is "ANNOTATION"
    var colLookupTable = {
      title:        { key: "TITLE",        dir: "ascending"  },
      tags:         { key: "TAGS",         dir: "ascending"  },
      url:          { key: "URI",          dir: "ascending"  },
      date:         { key: "DATE",         dir: "descending" },
      visitCount:   { key: "VISITCOUNT",   dir: "descending" },
      dateAdded:    { key: "DATEADDED",    dir: "descending" },
      lastModified: { key: "LASTMODIFIED", dir: "descending" },
      description:  { key: "ANNOTATION",
                      dir: "ascending",
                      anno: PlacesUIUtils.DESCRIPTION_ANNO }
    };

    // Make sure we have a valid column.
    if (!colLookupTable.hasOwnProperty(columnId))
      throw new Error("Invalid column");

    // Use a default sort direction if none has been specified.  If aDirection
    // is invalid, result.sortingMode will be undefined, which has the effect
    // of unsorting the tree.
    aDirection = (aDirection || colLookupTable[columnId].dir).toUpperCase();

    var sortConst = "SORT_BY_" + colLookupTable[columnId].key + "_" + aDirection;
    result.sortingAnnotation = colLookupTable[columnId].anno || "";
    result.sortingMode = Ci.nsINavHistoryQueryOptions[sortConst];
  }
};

var ContentArea = {
  _specialViews: new Map(),

  init: function CA_init() {
    this._deck = document.getElementById("placesViewsDeck");
    this._toolbar = document.getElementById("placesToolbar");
    ContentTree.init();
    this._setupView();
  },

  /**
   * Gets the content view to be used for loading the given query.
   * If a custom view was set by setContentViewForQueryString, that
   * view would be returned, else the default tree view is returned
   *
   * @param aQueryString
   *        a query string
   * @return the view to be used for loading aQueryString.
   */
  getContentViewForQueryString:
  function CA_getContentViewForQueryString(aQueryString) {
    try {
      if (this._specialViews.has(aQueryString)) {
        let { view, options } = this._specialViews.get(aQueryString);
        if (typeof view == "function") {
          view = view();
          this._specialViews.set(aQueryString, { view, options });
        }
        return view;
      }
    } catch (ex) {
      Cu.reportError(ex);
    }
    return ContentTree.view;
  },

  /**
   * Sets a custom view to be used rather than the default places tree
   * whenever the given query is selected in the left pane.
   * @param aQueryString
   *        a query string
   * @param aView
   *        Either the custom view or a function that will return the view
   *        the first (and only) time it's called.
   * @param [optional] aOptions
   *        Object defining special options for the view.
   * @see ContentTree.viewOptions for supported options and default values.
   */
  setContentViewForQueryString:
  function CA_setContentViewForQueryString(aQueryString, aView, aOptions) {
    if (!aQueryString ||
        typeof aView != "object" && typeof aView != "function")
      throw new Error("Invalid arguments");

    this._specialViews.set(aQueryString, { view: aView,
                                           options: aOptions || {} });
  },

  get currentView() {
    return PlacesUIUtils.getViewForNode(this._deck.selectedPanel);
  },
  set currentView(aNewView) {
    let oldView = this.currentView;
    if (oldView != aNewView) {
      this._deck.selectedPanel = aNewView.associatedElement;

      // If the content area inactivated view was focused, move focus
      // to the new view.
      if (document.activeElement == oldView.associatedElement)
        aNewView.associatedElement.focus();
    }
    return aNewView;
  },

  get currentPlace() {
    return this.currentView.place;
  },
  set currentPlace(aQueryString) {
    let oldView = this.currentView;
    let newView = this.getContentViewForQueryString(aQueryString);
    newView.place = aQueryString;
    if (oldView != newView) {
      oldView.active = false;
      this.currentView = newView;
      this._setupView();
      newView.active = true;
    }
    return aQueryString;
  },

  /**
   * Applies view options.
   */
  _setupView: function CA__setupView() {
    let options = this.currentViewOptions;

    // showDetailsPane.
    let detailsDeck = document.getElementById("detailsDeck");
    detailsDeck.hidden = !options.showDetailsPane;

    // toolbarSet.
    for (let elt of this._toolbar.childNodes) {
      elt.hidden = !options.toolbarSet.includes(elt.id);
    }
  },

  /**
   * Options for the current view.
   *
   * @see ContentTree.viewOptions for supported options and default values.
   */
  get currentViewOptions() {
    // Use ContentTree options as default.
    let viewOptions = ContentTree.viewOptions;
    if (this._specialViews.has(this.currentPlace)) {
      let { options } = this._specialViews.get(this.currentPlace);
      for (let option in options) {
        viewOptions[option] = options[option];
      }
    }
    return viewOptions;
  },

  focus() {
    this._deck.selectedPanel.focus();
  }
};

var ContentTree = {
  init: function CT_init() {
    this._view = document.getElementById("placeContent");
  },

  get view() {
    return this._view;
  },

  get viewOptions() {
    return Object.seal({
      showDetailsPane: true,
      toolbarSet: "placesMenu, toolbar-spacer, searchFilter"
    });
  },

  openSelectedNode: function CT_openSelectedNode(aEvent) {
    let view = this.view;
    PlacesUIUtils.openNodeWithEvent(view.selectedNode, aEvent, true);
  },

  onClick: function CT_onClick(aEvent) {
    let node = this.view.selectedNode;
    if (node) {
      let doubleClick = aEvent.button == 0 && aEvent.detail == 2;
      let middleClick = aEvent.button == 1 && aEvent.detail == 1;
      if (PlacesUtils.nodeIsURI(node) && (doubleClick || middleClick)) {
        // Open associated uri in the browser.
        this.openSelectedNode(aEvent);
      } else if (middleClick && PlacesUtils.nodeIsContainer(node)) {
        // The command execution function will take care of seeing if the
        // selection is a folder or a different container type, and will
        // load its contents in tabs.
        PlacesUIUtils.openContainerNodeInTabs(node, aEvent, this.view);
      }
    }
  },

  onKeyPress: function CT_onKeyPress(aEvent) {
    if (aEvent.keyCode == KeyEvent.DOM_VK_RETURN)
      this.openSelectedNode(aEvent);
  }
};
