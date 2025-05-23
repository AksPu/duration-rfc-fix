/* -*- Mode: C++; tab-width: 4; indent-tabs-mode: nil; c-basic-offset: 4 -*-
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/*
 * matches a real object against one or more pattern objects.
 * if you pass an array of pattern objects, |negate| controls whether to check
 * if the object matches ANY of the patterns, or NONE of the patterns.
 */
function matchObject(o, pattern, negate) {
  negate = Boolean(negate);

  function _match(o, pattern) {
    if (isinstance(pattern, Function)) {
      return pattern(o);
    }

    for (let p in pattern) {
      let val;
      /* nice to have, but slow as molases, allows you to match
       * properties of objects with obj$prop: "foo" syntax      */
      /*
                  if (p[0] == "$")
                  val = eval ("o." +
                  p.substr(1,p.length).replace (/\$/g, "."));
                  else
                */
      val = o[p];

      if (isinstance(pattern[p], Function)) {
        if (!pattern[p](val)) {
          return false;
        }
      } else {
        let ary = new String(val).match(pattern[p]);
        if (ary == null) {
          return false;
        }
        o.matchresult = ary;
      }
    }

    return true;
  }

  if (!isinstance(pattern, Array)) {
    return Boolean(negate ^ _match(o, pattern));
  }

  for (let i in pattern) {
    if (_match(o, pattern[i])) {
      return !negate;
    }
  }

  return negate;
}

/**
 * Event class for |CEventPump|.
 */
function CEvent(set, type, destObject, destMethod) {
  this.set = set;
  this.type = type;
  this.destObject = destObject;
  this.destMethod = destMethod;
  this.hooks = [];
}

/**
 * The event pump keeps a queue of pending events, processing them on-demand.
 *
 * You should never need to create an instance of this prototype; access the
 * event pump through |client.eventPump|. Most code should only need to use the
 * |addHook|, |getHook| and |removeHookByName| methods.
 */
function CEventPump(eventsPerStep) {
  /* event routing stops after this many levels, safety valve */
  this.MAX_EVENT_DEPTH = 50;
  /* When there are this many 'used' items in a queue, always clean up. At
   * this point it is MUCH more effecient to remove a block than a single
   * item (i.e. removing 1000 is much much faster than removing 1 item 1000
   * times [1]).
   */
  this.FORCE_CLEANUP_PTR = 1000;
  /* If there are less than this many items in a queue, clean up. This keeps
   * the queue empty normally, and is not that ineffecient [1].
   */
  this.MAX_AUTO_CLEANUP_LEN = 100;
  this.eventsPerStep = eventsPerStep;
  this.queue = [];
  this.queuePointer = 0;
  this.bulkQueue = [];
  this.bulkQueuePointer = 0;
  this.hooks = [];

  /* [1] The delay when removing items from an array (with unshift or splice,
   * and probably most operations) is NOT perportional to the number of items
   * being removed, instead it is proportional to the number of items LEFT.
   * Because of this, it is better to only remove small numbers of items when
   * the queue is small (MAX_AUTO_CLEANUP_LEN), and when it is large remove
   * only large chunks at a time (FORCE_CLEANUP_PTR), reducing the number of
   * resizes being done.
   */
}

CEventPump.prototype.onHook = function (e, hooks) {
  var h;

  if (typeof hooks == "undefined") {
    hooks = this.hooks;
  }

  for (h = hooks.length - 1; h >= 0; h--) {
    if (!hooks[h].enabled || !matchObject(e, hooks[h].pattern, hooks[h].neg)) {
      continue;
    }

    e.hooks.push(hooks[h]);
    try {
      var rv = hooks[h].f(e);
    } catch (ex) {
      dd(
        "hook #" +
          h +
          " '" +
          (typeof hooks[h].name != "undefined" ? hooks[h].name : "") +
          "' had an error!"
      );
      dd(formatException(ex));
    }
    if (typeof rv == "boolean" && rv == false) {
      dd(
        "hook #" +
          h +
          " '" +
          (typeof hooks[h].name != "undefined" ? hooks[h].name : "") +
          "' stopped hook processing."
      );
      return true;
    }
  }

  return false;
};

/**
 * Adds an event hook to be called when matching events are processed.
 *
 * All hooks should be given a meaningful name, to aid removal and debugging.
 * For plugins, an ideal technique for the name is to use |plugin.id| as a
 * prefix (e.g. <tt>plugin.id + "-my-super-hook"</tt>).
 *
 * @param f The function to call when an event matches |pattern|.
 * @param name A unique name for the hook. Used for removing the hook and
 *             debugging.
 * @param neg Optional. If specified with a |true| value, the hook will be
 *            called for events *not* matching |pattern|. Otherwise, the hook
 *            will be called for events matching |pattern|.
 * @param enabled Optional. If specified, sets the initial enabled/disabled
 *                state of the hook. By default, hooks are enabled. See
 *                |getHook|.
 * @param hooks Internal. Do not use.
 */
CEventPump.prototype.addHook = function (
  pattern,
  f,
  name,
  neg,
  enabled,
  hooks
) {
  if (typeof hooks == "undefined") {
    hooks = this.hooks;
  }

  if (typeof f != "function") {
    return false;
  }

  if (typeof enabled == "undefined") {
    enabled = true;
  } else {
    enabled = Boolean(enabled);
  }

  neg = Boolean(neg);

  var hook = {
    pattern,
    f,
    name,
    neg,
    enabled,
  };

  hooks.push(hook);

  return hook;
};

/**
 * Finds and returns data about a named event hook.
 *
 * You can use |getHook| to change the enabled state of an existing event hook:
 *   <tt>client.eventPump.getHook(myHookName).enabled = false;</tt>
 *   <tt>client.eventPump.getHook(myHookName).enabled = true;</tt>
 *
 * @param name The unique hook name to find and return data about.
 * @param hooks Internal. Do not use.
 * @returns If a match is found, an |Object| with properties matching the
 *          arguments to |addHook| is returned. Otherwise, |null| is returned.
 */
CEventPump.prototype.getHook = function (name, hooks) {
  if (typeof hooks == "undefined") {
    hooks = this.hooks;
  }

  for (var h in hooks) {
    if (hooks[h].name.toLowerCase() == name.toLowerCase()) {
      return hooks[h];
    }
  }

  return null;
};

/**
 * Removes an existing event hook by its name.
 *
 * @param name The unique hook name to find and remove.
 * @param hooks Internal. Do not use.
 * @returns |true| if the hook was found and removed, |false| otherwise.
 */
CEventPump.prototype.removeHookByName = function (name, hooks) {
  if (typeof hooks == "undefined") {
    hooks = this.hooks;
  }

  for (var h in hooks) {
    if (hooks[h].name.toLowerCase() == name.toLowerCase()) {
      hooks.splice(h, 1);
      return true;
    }
  }

  return false;
};

CEventPump.prototype.removeHookByIndex = function (idx, hooks) {
  if (typeof hooks == "undefined") {
    hooks = this.hooks;
  }

  return hooks.splice(idx, 1);
};

CEventPump.prototype.addEvent = function (e) {
  e.queuedAt = new Date();
  this.queue.push(e);
  return true;
};

CEventPump.prototype.addBulkEvent = function (e) {
  e.queuedAt = new Date();
  this.bulkQueue.push(e);
  return true;
};

CEventPump.prototype.routeEvent = function (e) {
  var count = 0;

  this.currentEvent = e;

  e.level = 0;
  while (e.destObject) {
    e.level++;
    this.onHook(e);
    var destObject = e.destObject;
    e.currentObject = destObject;
    e.destObject = void 0;

    switch (typeof destObject[e.destMethod]) {
      case "function":
        if (1) {
          try {
            destObject[e.destMethod](e);
          } catch (ex) {
            if (typeof ex == "string") {
              dd("Error routing event " + e.set + "." + e.type + ": " + ex);
            } else {
              dd(
                "Error routing event " +
                  e.set +
                  "." +
                  e.type +
                  ": " +
                  dumpObjectTree(ex) +
                  " in " +
                  e.destMethod +
                  "\n" +
                  ex
              );
              if ("stack" in ex) {
                dd(ex.stack);
              }
            }
          }
        } else {
          destObject[e.destMethod](e);
        }

        if (count++ > this.MAX_EVENT_DEPTH) {
          throw Components.Exception(
            "Too many events in chain",
            Cr.NS_ERROR_FAILURE
          );
        }
        break;

      case "undefined":
        //dd ("** " + e.destMethod + " does not exist.");
        break;

      default:
        dd("** " + e.destMethod + " is not a function.");
    }

    if (e.type != "event-end" && !e.destObject) {
      e.lastSet = e.set;
      e.set = "eventpump";
      e.lastType = e.type;
      e.type = "event-end";
      e.destMethod = "onEventEnd";
      e.destObject = this;
    }
  }

  delete this.currentEvent;

  return true;
};

CEventPump.prototype.stepEvents = function () {
  var i = 0;
  var st, en, e;

  st = new Date();
  while (i < this.eventsPerStep) {
    if (this.queuePointer >= this.queue.length) {
      break;
    }

    e = this.queue[this.queuePointer++];

    if (e.type == "yield") {
      break;
    }

    this.routeEvent(e);
    i++;
  }
  while (i < this.eventsPerStep) {
    if (this.bulkQueuePointer >= this.bulkQueue.length) {
      break;
    }

    e = this.bulkQueue[this.bulkQueuePointer++];

    if (e.type == "yield") {
      break;
    }

    this.routeEvent(e);
    i++;
  }
  en = new Date();

  // i == number of items handled this time.
  // We only want to do this if we handled at least 25% of our step-limit
  // and if we have a sane interval between st and en (not zero).
  if (i * 4 >= this.eventsPerStep && en - st > 0) {
    // Calculate the number of events that can be processed in 400ms.
    var newVal = (400 * i) / (en - st);

    // If anything skews it majorly, limit it to a minimum value.
    if (newVal < 10) {
      newVal = 10;
    }

    // Adjust the step-limit based on this "target" limit, but only do a
    // 25% change (underflow filter).
    this.eventsPerStep += Math.round((newVal - this.eventsPerStep) / 4);
  }

  // Clean up if we've handled a lot, or the queue is small.
  if (
    this.queuePointer >= this.FORCE_CLEANUP_PTR ||
    this.queue.length <= this.MAX_AUTO_CLEANUP_LEN
  ) {
    this.queue.splice(0, this.queuePointer);
    this.queuePointer = 0;
  }

  // Clean up if we've handled a lot, or the queue is small.
  if (
    this.bulkQueuePointer >= this.FORCE_CLEANUP_PTR ||
    this.bulkQueue.length <= this.MAX_AUTO_CLEANUP_LEN
  ) {
    this.bulkQueue.splice(0, this.bulkQueuePointer);
    this.bulkQueuePointer = 0;
  }

  return i;
};
