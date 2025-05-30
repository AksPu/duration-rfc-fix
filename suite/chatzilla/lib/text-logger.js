/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Serializer for lists of data that can be printed line-by-line.
 * If you pass an autoLimit, it will automatically call limit() once the number
 * of appended items exceeds the limit (so the number of items will never
 * exceed limit*2).
 */

function TextLogger(path, autoLimit) {
  // Check if we can open the path. This will throw if it doesn't work
  var f = new LocalFile(path, ">>");
  f.close();
  this.path = path;

  this.appended = 0;
  if (typeof autoLimit == "number") {
    this.autoLimit = autoLimit;
  } else {
    this.autoLimit = -1;
  }

  // Limit the amount of data in the file when constructing, when asked to.
  if (this.autoLimit != -1) {
    this.limit();
  }
}

/**
 * Append data (an array or single item) to the file
 */
TextLogger.prototype.append = function (data) {
  if (!isinstance(data, Array)) {
    data = [data];
  }

  // If we go over the limit, don't write everything twice:
  if (this.autoLimit != -1 && data.length + this.appended > this.autoLimit) {
    // Collect complete set of data instead:
    var dataInFile = this.read();
    var newData = dataInFile.concat(data);
    // Get the last |autoLimit| items: yay JS negative indexing!
    newData = newData.slice(-this.autoLimit);
    this.limit(newData);
    return true;
  }

  var file = new LocalFile(this.path, ">>");
  for (var i = 0; i < data.length; i++) {
    file.write(ecmaEscape(data[i]) + "\n");
  }
  file.close();
  this.appended += data.length;

  return true;
};

/**
 * Limit the data already in the file to the data provided, or the count given.
 */
TextLogger.prototype.limit = function (dataOrCount) {
  // Find data and count:
  var data = null,
    count = -1;
  if (isinstance(dataOrCount, Array)) {
    data = dataOrCount;
    count = data.length;
  } else if (typeof dataOrCount == "number") {
    count = dataOrCount;
    data = this.read();
  } else if (this.autoLimit != -1) {
    count = this.autoLimit;
    data = this.read();
  } else {
    throw Components.Exception(
      "Can't limit the length of the file without a limit...",
      Cr.NS_ERROR_FAILURE
    );
  }

  // Write the right data out. Note that we use the back of the array, not
  // the front (start from data.length - count), without dropping below 0:
  var start = Math.max(data.length - count, 0);
  var file = new LocalFile(this.path, ">");
  for (var i = start; i < data.length; i++) {
    file.write(ecmaEscape(data[i]) + "\n");
  }
  file.close();
  this.appended = 0;

  return true;
};

/**
 * Reads out the data currently in the file, and returns an array.
 */
TextLogger.prototype.read = function () {
  var rv = [],
    parsedLines = [],
    buffer = "";
  var file = new LocalFile(this.path, "<");
  while (true) {
    var newData = file.read();
    if (newData) {
      buffer += newData;
    } else if (buffer.length == 0) {
      break;
    }

    // Got more data in the buffer, so split into lines. Unless we're
    // done, the last one might not be complete yet, so save that one.
    // We split rather strictly on line ends, because empty lines should
    // be preserved.
    var lines = buffer.split(/\r?\n/);
    if (!newData) {
      buffer = "";
    } else {
      buffer = lines.pop();
    }

    rv = rv.concat(lines);
  }
  // Unescape here...
  for (var i = 0; i < rv.length; i++) {
    rv[i] = ecmaUnescape(rv[i]);
  }
  return rv;
};
