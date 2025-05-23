/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { IMServices } from "resource:///modules/IMServices.sys.mjs";
import { Status } from "resource:///modules/imStatusUtils.sys.mjs";
import { XPCOMUtils } from "resource://gre/modules/XPCOMUtils.sys.mjs";
import {
  executeSoon,
  nsSimpleEnumerator,
  EmptyEnumerator,
  ClassInfo,
} from "resource:///modules/imXPCOMUtils.sys.mjs";
import {
  ChatRoomFieldValues,
  GenericAccountPrototype,
  GenericAccountBuddyPrototype,
  GenericConvIMPrototype,
  GenericConvChatPrototype,
  GenericConversationPrototype,
  TooltipInfo,
} from "resource:///modules/jsProtoHelper.sys.mjs";
import { NormalizedMap } from "resource:///modules/NormalizedMap.sys.mjs";
import {
  Stanza,
  SupportedFeatures,
} from "resource:///modules/xmpp-xml.sys.mjs";
import { XMPPSession } from "resource:///modules/xmpp-session.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  DownloadUtils: "resource://gre/modules/DownloadUtils.sys.mjs",
  FileUtils: "resource://gre/modules/FileUtils.sys.mjs",
  NetUtil: "resource://gre/modules/NetUtil.sys.mjs",
});
XPCOMUtils.defineLazyServiceGetter(
  lazy,
  "imgTools",
  "@mozilla.org/image/tools;1",
  "imgITools"
);

ChromeUtils.defineLazyGetter(
  lazy,
  "l10n",
  () => new Localization(["chat/xmpp.ftl"], true)
);

ChromeUtils.defineLazyGetter(lazy, "TXTToHTML", function () {
  const cs = Cc["@mozilla.org/txttohtmlconv;1"].getService(
    Ci.mozITXTToHTMLConv
  );
  return aTxt => cs.scanTXT(aTxt, cs.kEntities);
});

/**
 * Parses the status from a presence stanza into an object of statusType,
 * statusText and idleSince.
 *
 * @param {XMLNode} aStanza - The presence stanza to parse.
 * @returns {{statusType: number, statusText: string, idleSince: number}}
 */
function parseStatus(aStanza) {
  let statusType = Ci.imIStatusInfo.STATUS_AVAILABLE;
  let show = aStanza.getElement(["show"]);
  if (show) {
    show = show.innerText;
    if (show == "away") {
      statusType = Ci.imIStatusInfo.STATUS_AWAY;
    } else if (show == "chat") {
      statusType = Ci.imIStatusInfo.STATUS_AVAILABLE; // FIXME
    } else if (show == "dnd") {
      statusType = Ci.imIStatusInfo.STATUS_UNAVAILABLE;
    } else if (show == "xa") {
      statusType = Ci.imIStatusInfo.STATUS_IDLE;
    }
  }

  let idleSince = 0;
  const date = _getDelay(aStanza);
  if (date) {
    idleSince = date.getTime();
  }

  const query = aStanza.getElement(["query"]);
  if (query && query.uri == Stanza.NS.last) {
    const now = Math.floor(Date.now() / 1000);
    idleSince = now - parseInt(query.attributes.seconds, 10);
    statusType = Ci.imIStatusInfo.STATUS_IDLE;
  }

  const status = aStanza.getElement(["status"]);
  const statusText = status ? status.innerText : "";

  return { statusType, statusText, idleSince };
}

/**
 * Returns a Date object for the delay value (stamp) in aStanza if it exists,
 * otherwise returns undefined. Returns undefined if the delay is invalid.
 *
 * @param {XMLNode} aStanza - The XML stanza to check for a delay.
 * @returns {Date | undefined}
 * @private
 */
function _getDelay(aStanza) {
  // XEP-0203: Delayed Delivery.
  let date;
  const delay = aStanza.getElement(["delay"]);
  if (delay && delay.uri == Stanza.NS.delay) {
    if (delay.attributes.stamp) {
      date = new Date(delay.attributes.stamp);
    }
  }
  if (date && isNaN(date.getTime())) {
    return undefined;
  }

  return date;
}

/**
 * Writes a message to a conversation as an outgoing message with optional date as the
 * message may be sent from another client.
 *
 * @param {GenericConversationPrototype} aConv - The conversation to write to.
 * @param {string} aMsg - The message to write.
 * @param {Date} [aDate] - The time the message was writen. If not provided, it will
 *   be calculated as now.
 * @private
 */
function _displaySentMsg(aConv, aMsg, aDate) {
  let who;
  if (aConv._account._connection) {
    who = aConv._account._connection._jid.jid;
  }
  if (!who) {
    who = aConv._account.name;
  }

  const flags = { outgoing: true };
  flags._alias = aConv.account.alias || aConv.account.statusInfo.displayName;

  if (aDate) {
    flags.time = aDate / 1000;
    flags.delayed = true;
  }
  aConv.writeMessage(who, aMsg, flags);
}

// The timespan after which we consider roomInfo to be stale.
var kListRefreshInterval = 12 * 60 * 60 * 1000; // 12 hours.

/* This is an ordered list, used to determine chat buddy flags:
 *  index = member    -> voiced
 *          moderator -> moderator
 *          admin     -> admin
 *          owner     -> founder
 */
var kRoles = [
  "outcast",
  "visitor",
  "participant",
  "member",
  "moderator",
  "admin",
  "owner",
];

function MUCParticipant(aNick, aJid, aPresenceStanza) {
  this._jid = aJid;
  this.name = aNick;
  this.onPresenceStanza(aPresenceStanza);
}
MUCParticipant.prototype = {
  __proto__: ClassInfo("prplIConvChatBuddy", "XMPP ConvChatBuddy object"),

  buddy: false,

  // The occupant jid of the participant which is of the form room@domain/nick.
  _jid: null,

  // The real jid of the participant which is of the form local@domain/resource.
  accountJid: null,

  statusType: null,
  statusText: null,
  get alias() {
    return this.name;
  },

  role: 2, // "participant" by default

  /**
   * Called when a presence stanza is received for this participant.
   *
   * @param {XMLNode} aStanza - The presence stanza.
   */
  onPresenceStanza(aStanza) {
    const statusInfo = parseStatus(aStanza);
    this.statusType = statusInfo.statusType;
    this.statusText = statusInfo.statusText;

    let x = aStanza.children.filter(
      child => child.localName == "x" && child.uri == Stanza.NS.muc_user
    );
    if (x.length == 0) {
      return;
    }

    // XEP-0045 (7.2.3): We only expect a single <x/> element of this namespace,
    // so we ignore any others.
    x = x[0];

    const item = x.getElement(["item"]);
    if (!item) {
      return;
    }

    this.role = Math.max(
      kRoles.indexOf(item.attributes.role),
      kRoles.indexOf(item.attributes.affiliation)
    );

    const accountJid = item.attributes.jid;
    if (accountJid) {
      this.accountJid = accountJid;
    }
  },

  get voiced() {
    /* FIXME: The "voiced" role corresponds to users that can send messages to
     * the room. If the chat is unmoderated, this should include everyone, not
     * just members. */
    return this.role == kRoles.indexOf("member");
  },
  get moderator() {
    return this.role == kRoles.indexOf("moderator");
  },
  get admin() {
    return this.role == kRoles.indexOf("admin");
  },
  get founder() {
    return this.role == kRoles.indexOf("owner");
  },
  typing: false,
};

// MUC (Multi-User Chat)
export var XMPPMUCConversationPrototype = {
  __proto__: GenericConvChatPrototype,
  // By default users are not in a MUC.
  _left: true,

  // Tracks all received messages to avoid possible duplication if the server
  // sends us the last few messages again when we rejoin a room.
  _messageIds: new Set(),

  _init(aAccount, aJID, aNick) {
    this._messageIds = new Set();
    GenericConvChatPrototype._init.call(this, aAccount, aJID, aNick);
  },

  _targetResource: "",

  // True while we are rejoining a room previously parted by the user.
  _rejoined: false,

  get topic() {
    return this._topic;
  },
  set topic(aTopic) {
    // XEP-0045 (8.1): Modifying the room subject.
    const subject = Stanza.node("subject", null, null, aTopic.trim());
    const s = Stanza.message(
      this.name,
      null,
      null,
      { type: "groupchat" },
      subject
    );
    const notAuthorized = lazy.l10n.formatValueSync(
      "conversation-error-change-topic-failed-not-authorized"
    );
    this._account.sendStanza(
      s,
      this._account.handleErrors(
        {
          forbidden: notAuthorized,
          notAcceptable: notAuthorized,
          itemNotFound: notAuthorized,
        },
        this
      )
    );
  },
  get topicSettable() {
    return true;
  },

  /* Called when the user enters a chat message */
  dispatchMessage(aMsg, aAction = false) {
    if (aAction) {
      // XEP-0245: The /me Command.
      // We need to prepend "/me " as the first four characters of the message
      // body.
      aMsg = "/me " + aMsg;
    }
    // XEP-0045 (7.4): Sending a message to all occupants in a room.
    const s = Stanza.message(this.name, aMsg, null, { type: "groupchat" });
    const notInRoom = lazy.l10n.formatValueSync(
      "conversation-error-send-failed-as-not-inroom",
      { mucName: this.name, message: aMsg }
    );
    this._account.sendStanza(
      s,
      this._account.handleErrors(
        {
          itemNotFound: notInRoom,
          notAcceptable: notInRoom,
        },
        this
      )
    );
  },

  /**
   * Called by the account when a presence stanza is received for this MUC.
   *
   * @param {XMLNode} aStanza - The presence stanza.
   */
  onPresenceStanza(aStanza) {
    const from = aStanza.attributes.from;
    const nick = this._account._parseJID(from).resource;
    const jid = this._account.normalize(from);
    const x = aStanza
      .getElements(["x"])
      .find(
        e => e.uri == Stanza.NS.muc_user || e.uri == Stanza.NS.vcard_update
      );

    // Check if the join failed.
    if (this.left && aStanza.attributes.type == "error") {
      const error = this._account.parseError(aStanza);
      let message;
      switch (error.condition) {
        case "not-authorized":
        case "registration-required":
          // XEP-0045 (7.2.7): Members-Only Rooms.
          message = lazy.l10n.formatValueSync(
            "conversation-error-join-failed-not-authorized"
          );
          break;
        case "not-allowed":
          message = lazy.l10n.formatValueSync(
            "conversation-error-creation-failed-not-allowed"
          );
          break;
        case "remote-server-not-found":
          message = lazy.l10n.formatValueSync(
            "conversation-error-join-failed-remote-server-not-found",
            { mucName: this.name }
          );
          break;
        case "forbidden":
          // XEP-0045 (7.2.8): Banned users.
          message = lazy.l10n.formatValueSync(
            "conversation-error-join-forbidden",
            { mucName: this.name }
          );
          break;
        default:
          message = lazy.l10n.formatValueSync(
            "conversation-error-join-failed",
            { mucName: this.name }
          );
          this.ERROR("Failed to join MUC: " + aStanza.convertToString());
          break;
      }
      this.writeMessage(this.name, message, { system: true, error: true });
      this.joining = false;
      return;
    }

    if (!x) {
      this.WARN(
        "Received a MUC presence stanza without an x element or " +
          "with a namespace we don't handle."
      );
      return;
    }
    // Handle a MUC resource avatar
    if (
      x.uri == Stanza.NS.vcard_update &&
      aStanza.attributes.from == this.normalizedName
    ) {
      const photo = aStanza.getElement(["x", "photo"]);
      if (photo && photo.uri == Stanza.NS.vcard_update) {
        const hash = photo.innerText;
        if (hash && hash != this._photoHash) {
          this._account._addVCardRequest(this.normalizedName);
        } else if (!hash && this._photoHash) {
          delete this._photoHash;
          this.convIconFilename = "";
        }
      }
      return;
    }
    const codes = x.getElements(["status"]).map(elt => elt.attributes.code);
    const item = x.getElement(["item"]);

    // Changes the nickname of a participant for this muc.
    const changeNick = () => {
      if (!item || !item.attributes.nick) {
        this.WARN(
          "Received a MUC presence code 303 or 210 stanza without an " +
            "item element or a nick attribute."
        );
        return;
      }
      const newNick = item.attributes.nick;
      this.updateNick(nick, newNick, nick == this.nick);
    };

    if (aStanza.attributes.type == "unavailable") {
      if (!this._participants.has(nick)) {
        this.WARN(
          "received unavailable presence for an unknown MUC participant: " +
            from
        );
        return;
      }
      if (codes.includes("303")) {
        // XEP-0045 (7.6): Changing Nickname.
        // Service Updates Nick for user.
        changeNick();
        return;
      }
      if (item && item.attributes.role == "none") {
        // XEP-0045: an occupant has left the room.
        this.removeParticipant(nick);

        // Who caused the participant to leave the room.
        const actor = item.getElement(["actor"]);
        let actorNick = actor ? actor.attributes.nick : "";
        let isActor = actorNick ? "-actor" : "";

        // Why the participant left.
        let reasonNode = item.getElement(["reason"]);
        let reason = reasonNode ? reasonNode.innerText : "";
        let isReason = reason ? "-reason" : "";

        const isYou = nick == this.nick ? "-you" : "";
        const affectedNick = isYou ? "" : nick;

        let participant = "";
        let reasonMessage = "";
        if (isYou) {
          this.left = true;
        }

        let message;
        if (codes.includes("301")) {
          // XEP-0045 (9.1): Banning a User.
          message = "conversation-message-banned";
          // conversation-message-banned-reason
          // conversation-message-banned-actor
          // conversation-message-banned-actor-reason
          // conversation-message-banned-you
          // conversation-message-banned-you-reason
          // conversation-message-banned-you-actor
          // conversation-message-banned-you-actor-reason
        } else if (codes.includes("307")) {
          // XEP-0045 (8.2): Kicking an Occupant.
          message = "conversation-message-kicked";
          // conversation-message-kicked-reason
          // conversation-message-kicked-actor
          // conversation-message-kicked-actor-reason
          // conversation-message-kicked-you
          // conversation-message-kicked-you-reason
          // conversation-message-kicked-you-actor
          // conversation-message-kicked-you-actor-reason
        } else if (codes.includes("322") || codes.includes("321")) {
          // XEP-0045: Inform user that he or she is being removed from the
          // room because the room has been changed to members-only and the
          // user is not a member.
          message = "conversation-message-removed-non-member";
          // conversation-message-removed-non-member-actor
          // conversation-message-removed-non-member-you
          // conversation-message-remove-non-member-you-actor

          // Reason is not supported by these strings.
          reason = isReason = "";
        } else if (codes.includes("332")) {
          // XEP-0045: Inform user that he or she is being removed from the
          // room because the MUC service is being shut down.
          message = "conversation-message-muc-shutdown";
          // conversation-message-removed-non-member-actor
          // conversation-message-removed-non-member-you
          // conversation-message-removed-non-member-you-actor

          // The reason here just duplicates what's in the system message.
          reason = isReason = "";
        } else {
          // XEP-0045 (7.14): Received when the user parts a room.
          message = "conversation-message-parted";
          // conversation-message-parted-reason
          // conversation-message-parted-you
          // conversation-message-parted-you-reason

          // The reason is in a status element in this case.
          reasonNode = aStanza.getElement(["status"]);
          reasonMessage = reasonNode ? reasonNode.innerText : "";
          reason = "";
          isReason = reasonMessage ? "-reason" : "";

          // Actor is not supported for these messages.
          actorNick = isActor = "";

          participant = affectedNick;
        }

        if (message) {
          const messageID = `${message}${isYou}${isActor}${isReason}`;
          const paramObject = {
            actorNick,
            affectedNick,
            reason,
            participant,
            message: reasonMessage,
          };
          this.writeMessage(
            this.name,
            lazy.l10n.formatValueSync(messageID, paramObject),
            {
              system: true,
            }
          );
        }
      } else {
        this.WARN("Unhandled type==unavailable MUC presence stanza.");
      }
      return;
    }

    if (codes.includes("201")) {
      // XEP-0045 (10.1): Creating room.
      // Service Acknowledges Room Creation
      // and Room is awaiting configuration.
      // XEP-0045 (10.1.2): Instant room.
      const query = Stanza.node(
        "query",
        Stanza.NS.muc_owner,
        null,
        Stanza.node("x", Stanza.NS.xdata, { type: "submit" })
      );
      const s = Stanza.iq("set", null, jid, query);
      this._account.sendStanza(s, aStanzaReceived => {
        if (aStanzaReceived.attributes.type != "result") {
          return false;
        }

        // XEP-0045: Service Informs New Room Owner of Success
        // for instant and reserved rooms.
        this.left = false;
        this.joining = false;
        return true;
      });
    } else if (codes.includes("210")) {
      // XEP-0045 (7.6): Changing Nickname.
      // Service modifies this user's nickname in accordance with local service
      // policies.
      changeNick();
      return;
    } else if (codes.includes("110")) {
      // XEP-0045: Room exists and joined successfully.
      this.left = false;
      this.joining = false;
      // TODO (Bug 1172350): Implement Service Discovery Extensions (XEP-0128) to obtain
      // configuration of this room.
    } else if (codes.includes("104") && nick == this.name) {
      // https://xmpp.org/extensions/inbox/muc-avatars.html (XEP-XXXX)
      this._account._addVCardRequest(this.normalizedName);
    }

    if (!this._participants.get(nick)) {
      const participant = new MUCParticipant(nick, from, aStanza);
      this._participants.set(nick, participant);
      this.notifyObservers(
        new nsSimpleEnumerator([participant]),
        "chat-buddy-add"
      );
      if (this.nick != nick && !this.joining) {
        this.writeMessage(
          this.name,
          lazy.l10n.formatValueSync("conversation-message-join", {
            participant: nick,
          }),
          {
            system: true,
          }
        );
      } else if (this.nick == nick && this._rejoined) {
        this.writeMessage(
          this.name,
          lazy.l10n.formatValueSync("conversation-message-rejoined"),
          {
            system: true,
          }
        );
        this._rejoined = false;
      }
    } else {
      this._participants.get(nick).onPresenceStanza(aStanza);
      this.notifyObservers(this._participants.get(nick), "chat-buddy-update");
    }
  },

  /* Called by the account when a message is received for this muc */
  incomingMessage(aMsg, aStanza, aDate) {
    let from = this._account._parseJID(aStanza.attributes.from).resource;
    const id = aStanza.attributes.id;
    const flags = {};
    if (!from) {
      flags.system = true;
      from = this.name;
    } else if (aStanza.attributes.type == "error") {
      aMsg = lazy.l10n.formatValueSync("conversation-error-not-delivered", {
        message: aMsg,
      });
      flags.system = true;
      flags.error = true;
    } else if (from == this._nick) {
      flags.outgoing = true;
    } else {
      flags.incoming = true;
    }
    if (aDate) {
      flags.time = aDate / 1000;
      flags.delayed = true;
    }
    if (id) {
      // Checks if a message exists in conversation to avoid duplication.
      if (this._messageIds.has(id)) {
        return;
      }
      this._messageIds.add(id);
    }
    this.writeMessage(from, aMsg, flags);
  },

  getNormalizedChatBuddyName(aNick) {
    return this._account.normalizeFullJid(this.name + "/" + aNick);
  },

  // Leaves MUC conversation.
  part(aMsg = null) {
    const s = Stanza.presence(
      { to: this.name + "/" + this._nick, type: "unavailable" },
      aMsg ? Stanza.node("status", null, null, aMsg.trim()) : null
    );
    this._account.sendStanza(s);
    delete this.chatRoomFields;
  },

  // Invites a user to MUC conversation.
  invite(aJID, aMsg = null) {
    // XEP-0045 (7.8): Inviting Another User to a Room.
    // XEP-0045 (7.8.2): Mediated Invitation.
    const invite = Stanza.node(
      "invite",
      null,
      { to: aJID },
      aMsg ? Stanza.node("reason", null, null, aMsg) : null
    );
    const x = Stanza.node("x", Stanza.NS.muc_user, null, invite);
    const s = Stanza.node("message", null, { to: this.name }, x);
    this._account.sendStanza(
      s,
      this._account.handleErrors(
        {
          forbidden: lazy.l10n.formatValueSync(
            "conversation-error-invite-failed-forbidden"
          ),
          // ejabberd uses error not-allowed to indicate that this account does not
          // have the required privileges to invite users instead of forbidden error,
          // and this is not mentioned in the spec (XEP-0045).
          notAllowed: lazy.l10n.formatValueSync(
            "conversation-error-invite-failed-forbidden"
          ),
          itemNotFound: lazy.l10n.formatValueSync(
            "conversation-error-failed-jid-not-found",
            { jabberIdentifier: aJID }
          ),
        },
        this
      )
    );
  },

  // Bans a participant from MUC conversation.
  ban(aNickName, aMsg = null) {
    // XEP-0045 (9.1): Banning a User.
    const participant = this._participants.get(aNickName);
    if (!participant) {
      this.writeMessage(
        this.name,
        lazy.l10n.formatValueSync("conversation-error-nick-not-in-room", {
          nick: aNickName,
        }),
        { system: true }
      );
      return;
    }
    if (!participant.accountJid) {
      this.writeMessage(
        this.name,
        lazy.l10n.formatValueSync(
          "conversation-error-ban-command-anonymous-room"
        ),
        { system: true }
      );
      return;
    }

    const attributes = { affiliation: "outcast", jid: participant.accountJid };
    const item = Stanza.node(
      "item",
      null,
      attributes,
      aMsg ? Stanza.node("reason", null, null, aMsg) : null
    );
    const s = Stanza.iq(
      "set",
      null,
      this.name,
      Stanza.node("query", Stanza.NS.muc_admin, null, item)
    );
    this._account.sendStanza(s, this._banKickHandler, this);
  },

  // Kicks a participant from MUC conversation.
  kick(aNickName, aMsg = null) {
    // XEP-0045 (8.2): Kicking an Occupant.
    const attributes = { role: "none", nick: aNickName };
    const item = Stanza.node(
      "item",
      null,
      attributes,
      aMsg ? Stanza.node("reason", null, null, aMsg) : null
    );
    const s = Stanza.iq(
      "set",
      null,
      this.name,
      Stanza.node("query", Stanza.NS.muc_admin, null, item)
    );
    this._account.sendStanza(s, this._banKickHandler, this);
  },

  // Callback for ban and kick commands.
  _banKickHandler(aStanza) {
    return this._account._handleResult(
      {
        notAllowed: lazy.l10n.formatValueSync(
          "conversation-error-ban-kick-command-not-allowed"
        ),
        conflict: lazy.l10n.formatValueSync(
          "conversation-error-ban-kick-command-conflict"
        ),
      },
      this
    )(aStanza);
  },

  // Changes nick in MUC conversation to a new one.
  setNick(aNewNick) {
    // XEP-0045 (7.6): Changing Nickname.
    const s = Stanza.presence({ to: this.name + "/" + aNewNick }, null);
    this._account.sendStanza(
      s,
      this._account.handleErrors(
        {
          // XEP-0045 (7.6): Changing Nickname (example 53).
          // TODO: We should discover if the user has a reserved nickname (maybe
          // before joining a room), cf. XEP-0045 (7.12).
          notAcceptable: lazy.l10n.formatValueSync(
            "conversation-error-change-nick-failed-not-acceptable",
            { nick: aNewNick }
          ),
          // XEP-0045 (7.2.9): Nickname Conflict.
          conflict: lazy.l10n.formatValueSync(
            "conversation-error-change-nick-failed-conflict",
            { nick: aNewNick }
          ),
        },
        this
      )
    );
  },

  // Called by the account when a message stanza is received for this muc and
  // needs to be handled.
  onMessageStanza(aStanza) {
    const x = aStanza.getElement(["x"]);
    const decline = x.getElement(["decline"]);
    if (decline) {
      // XEP-0045 (7.8): Inviting Another User to a Room.
      // XEP-0045 (7.8.2): Mediated Invitation.
      const invitee = decline.attributes.jid;
      const reasonNode = decline.getElement(["reason"]);
      const reason = reasonNode ? reasonNode.innerText : "";
      let msg;
      if (reason) {
        msg = lazy.l10n.formatValueSync(
          "conversation-message-invitation-declined-reason",
          {
            invitee,
            declineReason: reason,
          }
        );
      } else {
        msg = lazy.l10n.formatValueSync(
          "conversation-message-invitation-declined",
          { invitee }
        );
      }

      this.writeMessage(this.name, msg, { system: true });
    } else {
      this.WARN("Unhandled message stanza.");
    }
  },

  /* Called when the user closed the conversation */
  close() {
    if (!this.left) {
      this.part();
    }
    GenericConvChatPrototype.close.call(this);
  },
  unInit() {
    this._account.removeConversation(this.name);
    GenericConvChatPrototype.unInit.call(this);
  },

  _photoHash: null,
  _saveIcon(aPhotoNode) {
    this._account._saveResourceIcon(aPhotoNode, this).then(
      url => {
        this.convIconFilename = url;
      },
      error => {
        this._account.WARN(
          "Error while loading conversation icon for " +
            this.normalizedName +
            ": " +
            error.message
        );
      }
    );
  },
};

function XMPPMUCConversation(aAccount, aJID, aNick) {
  this._init(aAccount, aJID, aNick);
}
XMPPMUCConversation.prototype = XMPPMUCConversationPrototype;

/* Helper class for buddy conversations */
export var XMPPConversationPrototype = {
  __proto__: GenericConvIMPrototype,

  supportChatStateNotifications: true,
  get supportTypingNotifications() {
    // Typing notifications are supported if XEP-0085 is supported.
    return this.supportChatStateNotifications;
  },

  /**
   * The chat state of the local user.
   */
  _typingState: "active",

  // Indicates that current conversation is with a MUC participant and the
  // recipient jid (stored in the userName) is of the form room@domain/nick.
  _isMucParticipant: false,

  get buddy() {
    return this._account._buddies.get(this.name);
  },
  get title() {
    return this.contactDisplayName;
  },
  get contactDisplayName() {
    return this.buddy ? this.buddy.contactDisplayName : this.name;
  },
  get userName() {
    return this.buddy ? this.buddy.userName : this.name;
  },

  // Returns jid (room@domain/nick) if it is with a MUC participant, and the
  // name of conversation otherwise.
  get normalizedName() {
    if (this._isMucParticipant) {
      return this._account.normalizeFullJid(this.name);
    }
    return this._account.normalize(this.name);
  },

  // Used to avoid showing full jids in typing notifications.
  get shortName() {
    if (this.buddy) {
      return this.buddy.contactDisplayName;
    }

    const jid = this._account._parseJID(this.name);
    if (!jid) {
      return this.name;
    }

    // Returns nick of the recipient if conversation is with a participant of
    // a MUC we are in as jid of the recipient is of the form room@domain/nick.
    if (this._isMucParticipant) {
      return jid.resource;
    }

    return jid.node;
  },

  /**
   * Send the given typing state into the conversation.
   *
   * @param {int} newState
   * @private
   */
  setTypingState(newState) {
    // See XEP-0085: Chat State Notifications
    let state = "active";
    if (newState === Ci.prplIConvIM.TYPING) {
      state = "composing";
    } else if (newState === Ci.prplIConvIM.TYPED) {
      state = "paused";
    }

    if (this._typingState === state) {
      return;
    }

    const s = Stanza.message(this.to, null, state);

    // We don't care about errors in response to typing notifications
    // (e.g. because the user has left the room when talking to a MUC
    // participant).
    this._account.sendStanza(s, () => true);

    this._typingState = state;
  },

  // Holds the resource of user that you are currently talking to, but if the
  // user is a participant of a MUC we are in, holds the nick of user you are
  // talking to.
  _targetResource: "",

  get to() {
    if (!this._targetResource || this._isMucParticipant) {
      return this.userName;
    }
    return this.userName + "/" + this._targetResource;
  },

  /* Called when the user enters a chat message */
  dispatchMessage(aMsg, aAction = false) {
    if (aAction) {
      // XEP-0245: The /me Command.
      // We need to prepend "/me " as the first four characters of the message
      // body.
      aMsg = "/me" + aMsg;
    }
    // Reset the user's state to active, if supported.
    const cs = this.shouldSendTypingNotifications ? "active" : null;
    const s = Stanza.message(this.to, aMsg, cs);
    this._account.sendStanza(s);
    _displaySentMsg(this, aMsg);
    delete this._typingState;
  },

  // Invites the contact to a MUC room.
  invite(aRoomJid, aPassword = null) {
    // XEP-0045 (7.8): Inviting Another User to a Room.
    // XEP-0045 (7.8.1) and XEP-0249: Direct Invitation.
    const x = Stanza.node("x", Stanza.NS.conference, {
      jid: aRoomJid,
      password: aPassword,
    });
    this._account.sendStanza(Stanza.node("message", null, { to: this.to }, x));
  },

  // Query the user for its Software Version.
  // XEP-0092: Software Version.
  getVersion() {
    // TODO: Use Service Discovery to determine if the user's client supports
    // jabber:iq:version protocol.

    const s = Stanza.iq(
      "get",
      null,
      this.to,
      Stanza.node("query", Stanza.NS.version)
    );
    this._account.sendStanza(s, aStanza => {
      // TODO: handle other errors that can result from querying
      // user for its software version.
      if (
        this._account.handleErrors(
          {
            default: lazy.l10n.formatValueSync(
              "conversation-error-version-unknown"
            ),
          },
          this
        )(aStanza)
      ) {
        return;
      }

      const query = aStanza.getElement(["query"]);
      if (!query || query.uri != Stanza.NS.version) {
        this.WARN(
          "Received a response to version query which does not " +
            "contain query element or 'jabber:iq:version' namespace."
        );
        return;
      }

      const name = query.getElement(["name"]);
      const version = query.getElement(["version"]);
      if (!name || !version) {
        // XEP-0092: name and version elements are REQUIRED.
        this.WARN(
          "Received a response to version query which does not " +
            "contain name or version."
        );
        return;
      }

      let messageID = "conversation-message-version";
      const paramObject = {
        user: this.shortName,
        clientName: name.innerText,
        clientVersion: version.innerText,
      };

      // XEP-0092: os is OPTIONAL.
      const os = query.getElement(["os"]);
      if (os) {
        paramObject.systemResponse = os.innerText;
        messageID = `${messageID}-with-os`;
      }

      this.writeMessage(
        this.name,
        lazy.l10n.formatValueSync(messageID, paramObject),
        {
          system: true,
        }
      );
    });
  },

  /* Perform entity escaping before displaying the message. We assume incoming
     messages have already been escaped, and will otherwise be filtered. */
  prepareForDisplaying(aMsg) {
    if (aMsg.outgoing && !aMsg.system) {
      aMsg.displayMessage = lazy.TXTToHTML(aMsg.displayMessage);
    }
    GenericConversationPrototype.prepareForDisplaying.apply(this, arguments);
  },

  /* Called by the account when a message is received from the buddy */
  incomingMessage(aMsg, aStanza, aDate) {
    const from = aStanza.attributes.from;
    this._targetResource = this._account._parseJID(from).resource;
    let flags = {};
    const error = this._account.parseError(aStanza);
    if (error) {
      const norm = this._account.normalize(from);
      const muc = this._account._mucs.get(norm);

      if (!aMsg) {
        // Failed outgoing message.
        switch (error.condition) {
          case "remote-server-not-found":
            aMsg = lazy.l10n.formatValueSync(
              "conversation-error-remote-server-not-found"
            );
            break;
          case "service-unavailable":
            aMsg = lazy.l10n.formatValueSync(
              "conversation-error-send-service-unavailable",
              { nick: this.shortName }
            );
            break;
          default:
            aMsg = lazy.l10n.formatValueSync(
              "conversation-error-unknown-send-error"
            );
            break;
        }
      } else if (
        this._isMucParticipant &&
        muc &&
        !muc.left &&
        error.condition == "item-not-found"
      ) {
        // XEP-0045 (7.5): MUC private messages.
        // If we try to send to participant not in a room we are in.
        aMsg = lazy.l10n.formatValueSync(
          "conversation-error-send-failed-as-recipient-not-inroom",
          {
            jabberIdentifier: this._targetResource,
            message: aMsg,
          }
        );
      } else if (
        this._isMucParticipant &&
        (error.condition == "item-not-found" ||
          error.condition == "not-acceptable")
      ) {
        // If we left a room and try to send to a participant in it or the
        // room is removed.
        aMsg = lazy.l10n.formatValueSync(
          "conversation-error-send-failed-as-not-inroom",
          {
            mucName: this._account.normalize(from),
            message: aMsg,
          }
        );
      } else {
        aMsg = lazy.l10n.formatValueSync("conversation-error-not-delivered", {
          message: aMsg,
        });
      }
      flags.system = true;
      flags.error = true;
    } else {
      flags = { incoming: true, _alias: this.contactDisplayName };
      // XEP-0245: The /me Command.
      if (aMsg.startsWith("/me ")) {
        flags.action = true;
        aMsg = aMsg.slice(4);
      }
    }
    if (aDate) {
      flags.time = aDate / 1000;
      flags.delayed = true;
    }
    this.writeMessage(from, aMsg, flags);
  },

  /* Called when the user closed the conversation */
  close() {
    // TODO send the stanza indicating we have left the conversation?
    GenericConvIMPrototype.close.call(this);
  },
  unInit() {
    this._account.removeConversation(this.normalizedName);
    GenericConvIMPrototype.unInit.call(this);
  },
};

// Creates XMPP conversation.
function XMPPConversation(aAccount, aNormalizedName, aMucParticipant) {
  this._init(aAccount, aNormalizedName);
  if (aMucParticipant) {
    this._isMucParticipant = true;
  }
}
XMPPConversation.prototype = XMPPConversationPrototype;

/* Helper class for buddies */
export var XMPPAccountBuddyPrototype = {
  __proto__: GenericAccountBuddyPrototype,

  subscription: "none",
  // Returns a list of TooltipInfo objects to be displayed when the user
  // hovers over the buddy.
  getTooltipInfo() {
    if (!this._account.connected) {
      return null;
    }

    const tooltipInfo = [];
    if (this._resources) {
      for (const r in this._resources) {
        const status = this._resources[r];
        let statusString = Status.toLabel(status.statusType);
        if (
          status.statusType == Ci.imIStatusInfo.STATUS_IDLE &&
          status.idleSince
        ) {
          const now = Math.floor(Date.now() / 1000);
          const valuesAndUnits = lazy.DownloadUtils.convertTimeUnits(
            now - status.idleSince
          );
          if (!valuesAndUnits[2]) {
            valuesAndUnits.splice(2, 2);
          }
          statusString += " (" + valuesAndUnits.join(" ") + ")";
        }
        if (status.statusText) {
          statusString += " - " + status.statusText;
        }
        const label = r
          ? lazy.l10n.formatValueSync("tooltip-status", {
              resourceIdentifier: r,
            })
          : lazy.l10n.formatValueSync("tooltip-status-no-resource");
        tooltipInfo.push(new TooltipInfo(label, statusString));
      }
    }

    // The subscription value is interesting to display only in unusual cases.
    if (this.subscription != "both") {
      tooltipInfo.push(
        new TooltipInfo(
          lazy.l10n.formatValueSync("tooltip-subscription"),
          this.subscription
        )
      );
    }

    return tooltipInfo;
  },

  // _rosterAlias is the value stored in the roster on the XMPP
  // server. For most servers we will be read/write.
  _rosterAlias: "",
  set rosterAlias(aNewAlias) {
    const old = this.displayName;
    this._rosterAlias = aNewAlias;
    if (old != this.displayName) {
      this._notifyObservers("display-name-changed", old);
    }
  },
  _vCardReceived: false,
  // _vCardFormattedName is the display name the contact has set for
  // himself in his vCard. It's read-only from our point of view.
  _vCardFormattedName: "",
  set vCardFormattedName(aNewFormattedName) {
    const old = this.displayName;
    this._vCardFormattedName = aNewFormattedName;
    if (old != this.displayName) {
      this._notifyObservers("display-name-changed", old);
    }
  },

  // _serverAlias is set by jsProtoHelper to the value we cached in sqlite.
  // Use it only if we have neither of the other two values; usually because
  // we haven't connected to the server yet.
  get serverAlias() {
    return this._rosterAlias || this._vCardFormattedName || this._serverAlias;
  },
  set serverAlias(aNewAlias) {
    if (!this._rosterItem) {
      this.ERROR(
        "attempting to update the server alias of an account buddy " +
          "for which we haven't received a roster item."
      );
      return;
    }

    const item = this._rosterItem;
    if (aNewAlias) {
      item.attributes.name = aNewAlias;
    } else if ("name" in item.attributes) {
      delete item.attributes.name;
    }

    const s = Stanza.iq(
      "set",
      null,
      null,
      Stanza.node("query", Stanza.NS.roster, null, item)
    );
    this._account.sendStanza(s);

    // If we are going to change the alias on the server, discard the cached
    // value that we got from our local sqlite storage at startup.
    delete this._serverAlias;
  },

  /* Display name of the buddy */
  get contactDisplayName() {
    return this.buddy.contact.displayName || this.displayName;
  },

  get tag() {
    return this._tag;
  },
  set tag(aNewTag) {
    const oldTag = this._tag;
    if (oldTag.name == aNewTag.name) {
      this.ERROR("attempting to set the tag to the same value");
      return;
    }

    this._tag = aNewTag;
    IMServices.contacts.accountBuddyMoved(this, oldTag, aNewTag);

    if (!this._rosterItem) {
      this.ERROR(
        "attempting to change the tag of an account buddy without roster item"
      );
      return;
    }

    const item = this._rosterItem;
    const oldXML = item.getXML();
    // Remove the old tag if it was listed in the roster item.
    item.children = item.children.filter(
      c => c.qName != "group" || c.innerText != oldTag.name
    );
    // Ensure the new tag is listed.
    const newTagName = aNewTag.name;
    if (!item.getChildren("group").some(g => g.innerText == newTagName)) {
      item.addChild(Stanza.node("group", null, null, newTagName));
    }
    // Avoid sending anything to the server if the roster item hasn't changed.
    // It's possible that the roster item hasn't changed if the roster
    // item had several groups and the user moved locally the contact
    // to another group where it already was on the server.
    if (item.getXML() == oldXML) {
      return;
    }

    const s = Stanza.iq(
      "set",
      null,
      null,
      Stanza.node("query", Stanza.NS.roster, null, item)
    );
    this._account.sendStanza(s);
  },

  remove() {
    if (!this._account.connected) {
      return;
    }

    const s = Stanza.iq(
      "set",
      null,
      null,
      Stanza.node(
        "query",
        Stanza.NS.roster,
        null,
        Stanza.node("item", null, {
          jid: this.normalizedName,
          subscription: "remove",
        })
      )
    );
    this._account.sendStanza(s);
  },

  _photoHash: null,
  _saveIcon(aPhotoNode) {
    this._account._saveResourceIcon(aPhotoNode, this).then(
      url => {
        this.buddyIconFilename = url;
      },
      error => {
        this._account.WARN(
          "Error loading buddy icon for " +
            this.normalizedName +
            ": " +
            error.message
        );
      }
    );
  },

  _preferredResource: undefined,
  _resources: null,
  onAccountDisconnected() {
    delete this._preferredResource;
    delete this._resources;
  },
  /**
   * Called by the account when a presence stanza is received for this buddy.
   *
   * @param {XMLNode} aStanza - The presence stanza.
   */
  onPresenceStanza(aStanza) {
    let preferred = this._preferredResource;

    // Facebook chat's XMPP server doesn't send resources, let's
    // replace undefined resources with empty resources.
    const resource =
      this._account._parseJID(aStanza.attributes.from).resource || "";

    const type = aStanza.attributes.type;

    // Reset typing status if the buddy is in a conversation and becomes unavailable.
    const conv = this._account._conv.get(this.normalizedName);
    if (type == "unavailable" && conv) {
      conv.updateTyping(Ci.prplIConvIM.NOT_TYPING, this.contactDisplayName);
    }

    if (type == "unavailable" || type == "error") {
      if (!this._resources || !(resource in this._resources)) {
        // Ignore for already offline resources.
        return;
      }
      delete this._resources[resource];
      if (preferred == resource) {
        preferred = undefined;
      }
    } else {
      const statusInfo = parseStatus(aStanza);
      let priority = aStanza.getElement(["priority"]);
      priority = priority ? parseInt(priority.innerText, 10) : 0;

      if (!this._resources) {
        this._resources = {};
      }
      this._resources[resource] = {
        statusType: statusInfo.statusType,
        statusText: statusInfo.statusText,
        idleSince: statusInfo.idleSince,
        priority,
        stanza: aStanza,
      };
    }

    const photo = aStanza.getElement(["x", "photo"]);
    if (photo && photo.uri == Stanza.NS.vcard_update) {
      const hash = photo.innerText;
      if (hash && hash != this._photoHash) {
        this._account._addVCardRequest(this.normalizedName);
      } else if (!hash && this._photoHash) {
        delete this._photoHash;
        this.buddyIconFilename = "";
      }
    }

    for (const r in this._resources) {
      if (
        preferred === undefined ||
        this._resources[r].statusType > this._resources[preferred].statusType
      ) {
        // FIXME also compare priorities...
        preferred = r;
      }
    }
    if (
      preferred != undefined &&
      preferred == this._preferredResource &&
      resource != preferred
    ) {
      // The presence information change is only for an unused resource,
      // only potential buddy tooltips need to be refreshed.
      this._notifyObservers("status-detail-changed");
      return;
    }

    // Presence info has changed enough that if we are having a
    // conversation with one resource of this buddy, we should send
    // the next message to all resources.
    // FIXME: the test here isn't exactly right...
    if (
      this._preferredResource != preferred &&
      this._account._conv.has(this.normalizedName)
    ) {
      delete this._account._conv.get(this.normalizedName)._targetResource;
    }

    this._preferredResource = preferred;
    if (preferred === undefined) {
      let statusType = Ci.imIStatusInfo.STATUS_UNKNOWN;
      if (type == "unavailable") {
        statusType = Ci.imIStatusInfo.STATUS_OFFLINE;
      }
      this.setStatus(statusType, "");
    } else {
      preferred = this._resources[preferred];
      this.setStatus(preferred.statusType, preferred.statusText);
    }
  },

  /* Can send messages to buddies who appear offline */
  get canSendMessage() {
    return this.account.connected;
  },

  /* Called when the user wants to chat with the buddy */
  createConversation() {
    return this._account.createConversation(this.normalizedName);
  },
};

function XMPPAccountBuddy(aAccount, aBuddy, aTag, aUserName) {
  this._init(aAccount, aBuddy, aTag, aUserName);
}
XMPPAccountBuddy.prototype = XMPPAccountBuddyPrototype;

var XMPPRoomInfoPrototype = {
  __proto__: ClassInfo("prplIRoomInfo", "XMPP RoomInfo Object"),
  get topic() {
    return "";
  },
  get participantCount() {
    return Ci.prplIRoomInfo.NO_PARTICIPANT_COUNT;
  },
  get chatRoomFieldValues() {
    const roomJid = this._account._roomList.get(this.name);
    return this._account.getChatRoomFieldValuesFromString(roomJid);
  },
};
function XMPPRoomInfo(aName, aAccount) {
  this.name = aName;
  this._account = aAccount;
}
XMPPRoomInfo.prototype = XMPPRoomInfoPrototype;

/* Helper class for account */
export var XMPPAccountPrototype = {
  __proto__: GenericAccountPrototype,

  _jid: null, // parsed Jabber ID: node, domain, resource
  _connection: null, // XMPPSession socket
  authMechanisms: null, // hook to let prpls tweak the list of auth mechanisms

  // Contains the domain of MUC service which is obtained using service
  // discovery.
  _mucService: null,

  // Maps room names to room jid.
  _roomList: new Map(),

  // Callbacks used when roomInfo is available.
  _roomInfoCallbacks: new Set(),

  // Determines if roomInfo that we have is expired or not.
  _lastListTime: 0,
  get isRoomInfoStale() {
    return Date.now() - this._lastListTime > kListRefreshInterval;
  },

  // If true, we are waiting for replies.
  _pendingList: false,

  // An array of jids for which we still need to request vCards.
  _pendingVCardRequests: [],

  // XEP-0280: Message Carbons.
  // If true, message carbons are currently enabled.
  _isCarbonsEnabled: false,

  /* Generate unique id for a stanza. Using id and unique sid is defined in
   * RFC 6120 (Section 8.2.3, 4.7.3).
   */
  generateId: () => Services.uuid.generateUUID().toString().slice(1, -1),

  _init(aProtoInstance, aImAccount) {
    GenericAccountPrototype._init.call(this, aProtoInstance, aImAccount);

    // Ongoing conversations.
    // The keys of this._conv are assumed to be normalized like account@domain
    // for normal conversations and like room@domain/nick for MUC participant
    // convs.
    this._conv = new NormalizedMap(this.normalizeFullJid.bind(this));

    this._buddies = new NormalizedMap(this.normalize.bind(this));
    this._mucs = new NormalizedMap(this.normalize.bind(this));

    this._pendingVCardRequests = [];
  },

  get canJoinChat() {
    return true;
  },
  chatRoomFields: {
    room: {
      get label() {
        return lazy.l10n.formatValueSync("chat-room-field-room");
      },
      required: true,
    },
    server: {
      get label() {
        return lazy.l10n.formatValueSync("chat-room-field-server");
      },
      required: true,
    },
    nick: {
      get label() {
        return lazy.l10n.formatValueSync("chat-room-field-nick");
      },
      required: true,
    },
    password: {
      get label() {
        return lazy.l10n.formatValueSync("chat-room-field-password");
      },
      isPassword: true,
    },
  },
  getChatRoomFieldValuesFromString(aString) {
    // TODO Does this make sense?
    if (!aString) {
      return new ChatRoomFieldValues({ nick: this._jid.node });
    }

    const params = aString.trim().split(/\s+/);
    const jid = this._parseJID(params[0]);

    // In MUC join command, node is required as it represents a room, but domain
    // and resource are optional as we get the MUC domain from service discovery.
    //
    // _parseJID requires a domain and not node, if only a single field is provided
    // treat it as the node and replace the domain with the MUC service domain.
    if (!jid.node && jid.domain) {
      jid.node = jid.domain;
      jid.domain = this._mucService;
    }

    const chatFields = {
      room: jid.node,
      server: jid.domain || this._mucService,
      nick: jid.resource || this._jid.node,
    };
    if (params.length > 1) {
      chatFields.password = params[1];
    }
    return new ChatRoomFieldValues(chatFields);
  },
  /**
   * XMPP provides the user's nick and the current MUC service as the server name.
   */
  getChatRoomDefaultFieldValues() {
    const chatFields = {
      nick: this._jid.node,
    };
    if (this._mucService) {
      chatFields.server = this._mucService;
    }

    return new ChatRoomFieldValues(chatFields);
  },

  // XEP-0045: Requests joining room if it exists or
  // creating room if it does not exist.
  joinChat(aComponents) {
    const jid =
      aComponents.getValue("room") + "@" + aComponents.getValue("server");
    const nick = aComponents.getValue("nick");

    let muc = this._mucs.get(jid);
    if (muc) {
      if (!muc.left) {
        // We are already in this conversation.
        return muc;
      } else if (!muc.chatRoomFields) {
        // We are rejoining a room that was parted by the user.
        muc._rejoined = true;
      }
    } else {
      muc = new this._MUCConversationConstructor(this, jid, nick);
      this._mucs.set(jid, muc);
    }

    // Store the prplIChatRoomFieldValues to enable later reconnections.
    muc.chatRoomFields = aComponents;
    muc.joining = true;
    muc.removeAllParticipants();

    const password = aComponents.getValue("password");
    const x = Stanza.node(
      "x",
      Stanza.NS.muc,
      null,
      password ? Stanza.node("password", null, null, password) : null
    );
    let logString;
    if (password) {
      logString =
        "<presence .../> (Stanza containing password to join MUC " +
        jid +
        "/" +
        nick +
        " not logged)";
    }
    this.sendStanza(
      Stanza.presence({ to: jid + "/" + nick }, x),
      undefined,
      undefined,
      logString
    );
    return muc;
  },

  _idleSince: 0,
  observe(aSubject, aTopic, aData) {
    if (aTopic == "idle-time-changed") {
      const idleTime = parseInt(aData, 10);
      if (idleTime) {
        this._idleSince = Math.floor(Date.now() / 1000) - idleTime;
      } else {
        delete this._idleSince;
      }
      this._shouldSendPresenceForIdlenessChange = true;
      executeSoon(
        function () {
          if ("_shouldSendPresenceForIdlenessChange" in this) {
            this._sendPresence();
          }
        }.bind(this)
      );
    } else if (aTopic == "status-changed") {
      this._sendPresence();
    } else if (aTopic == "user-icon-changed") {
      delete this._cachedUserIcon;
      this._forceUserIconUpdate = true;
      this._sendVCard();
    } else if (aTopic == "user-display-name-changed") {
      this._forceUserDisplayNameUpdate = true;
    }
    this._sendVCard();
  },

  /* GenericAccountPrototype events */
  /* Connect to the server */
  connect() {
    this._jid = this._parseJID(this.name);

    // For the resource, if the user has edited the option, always use that.
    if (this.prefs.prefHasUserValue("resource")) {
      const resource = this.getString("resource");

      // this._jid needs to be updated. This value is however never used
      // because while connected it's the jid of the session that's
      // interesting.
      this._jid = this._setJID(this._jid.domain, this._jid.node, resource);
    } else if (this._jid.resource) {
      // If there is a resource in the account name (inherited from libpurple),
      // migrate it to the pref so it appears correctly in the advanced account
      // options next time.
      this.prefs.setStringPref("resource", this._jid.resource);
    }

    this._connection = new XMPPSession(
      this.getString("server") || this._jid.domain,
      this.getInt("port") || 5222,
      this.getString("connection_security"),
      this._jid,
      this.imAccount.password,
      this
    );
  },

  remove() {
    this._conv.forEach(conv => conv.close());
    this._mucs.forEach(muc => muc.close());
    this._buddies.forEach((buddy, jid) => this._forgetRosterItem(jid));
  },

  unInit() {
    if (this._connection) {
      this._disconnect(undefined, undefined, true);
    }
    delete this._jid;
    delete this._conv;
    delete this._buddies;
    delete this._mucs;
  },

  /* Disconnect from the server */
  disconnect() {
    this._disconnect();
  },

  addBuddy(aTag, aName) {
    if (!this._connection) {
      throw new Error("The account isn't connected");
    }

    const jid = this.normalize(aName);
    if (!jid || !jid.includes("@")) {
      throw new Error("Invalid username");
    }

    if (this._buddies.has(jid)) {
      const subscription = this._buddies.get(jid).subscription;
      if (subscription && (subscription == "both" || subscription == "to")) {
        this.DEBUG("not re-adding an existing buddy");
        return;
      }
    } else {
      const s = Stanza.iq(
        "set",
        null,
        null,
        Stanza.node(
          "query",
          Stanza.NS.roster,
          null,
          Stanza.node(
            "item",
            null,
            { jid },
            Stanza.node("group", null, null, aTag.name)
          )
        )
      );
      this.sendStanza(
        s,
        this._handleResult({
          default: aError => {
            this.WARN(
              "Unable to add a roster item due to " + aError + " error."
            );
          },
        })
      );
    }
    this.sendStanza(Stanza.presence({ to: jid, type: "subscribe" }));
  },

  /* Loads a buddy from the local storage.
   * Called for each buddy locally stored before connecting
   * to the server. */
  loadBuddy(aBuddy, aTag) {
    const buddy = new this._accountBuddyConstructor(this, aBuddy, aTag);
    this._buddies.set(buddy.normalizedName, buddy);
    return buddy;
  },

  /* Replies to a buddy request in order to accept it or deny it. */
  replyToBuddyRequest(aReply, aRequest) {
    if (!this._connection) {
      return;
    }
    const s = Stanza.presence({ to: aRequest.userName, type: aReply });
    this.sendStanza(s);
    this.removeBuddyRequest(aRequest);
  },

  requestBuddyInfo(aJid) {
    if (!this.connected) {
      Services.obs.notifyObservers(EmptyEnumerator, "user-info-received", aJid);
      return;
    }

    let userName;
    const tooltipInfo = [];
    const jid = this._parseJID(aJid);
    const muc = this._mucs.get(jid.node + "@" + jid.domain);
    let participant;
    if (muc) {
      participant = muc._participants.get(jid.resource);
      if (participant) {
        if (participant.accountJid) {
          userName = participant.accountJid;
        }
        if (!muc.left) {
          const statusType = participant.statusType;
          const statusText = participant.statusText;
          tooltipInfo.push(
            new TooltipInfo(statusType, statusText, Ci.prplITooltipInfo.status)
          );

          if (participant.buddyIconFilename) {
            tooltipInfo.push(
              new TooltipInfo(
                null,
                participant.buddyIconFilename,
                Ci.prplITooltipInfo.icon
              )
            );
          }
        }
      }
    }
    Services.obs.notifyObservers(
      new nsSimpleEnumerator(tooltipInfo),
      "user-info-received",
      aJid
    );

    const iq = Stanza.iq(
      "get",
      null,
      aJid,
      Stanza.node("vCard", Stanza.NS.vcard)
    );
    this.sendStanza(iq, aStanza => {
      let vCardInfo = {};
      const vCardNode = aStanza.getElement(["vCard"]);

      // In the case of an error response, we just notify the observers with
      // what info we already have.
      if (aStanza.attributes.type == "result" && vCardNode) {
        vCardInfo = this.parseVCard(vCardNode);
      }

      // The real jid of participant which is of the form local@domain/resource.
      // We consider the jid is provided by server is more correct than jid is
      // set by the user.
      if (userName) {
        vCardInfo.userName = userName;
      }

      // vCard fields we want to display in the tooltip.
      const kTooltipFields = {
        userName: "tooltip-user-name",
        fullName: "tooltip-full-name",
        nickname: "tooltip-nickname",
        title: "tooltip-title",
        organization: "tooltip-organization",
        email: "tooltip-email",
        birthday: "tooltip-birthday",
        locality: "tooltip-locality",
        country: "tooltip-country",
        telephone: "tooltip-telephone",
      };

      const vCard = [];
      for (const [field, stringKey] of Object.entries(kTooltipFields)) {
        if (vCardInfo.hasOwnProperty(field)) {
          vCard.push(
            new TooltipInfo(
              lazy.l10n.formatValueSync(stringKey),
              vCardInfo[field]
            )
          );
        }
      }
      if (vCardInfo.photo) {
        const dataURI = this._getPhotoURI(vCardInfo.photo);

        // Store the photo URI for this participant.
        if (participant) {
          participant.buddyIconFilename = dataURI;
        }

        vCard.push(new TooltipInfo(null, dataURI, Ci.prplITooltipInfo.icon));
      }
      Services.obs.notifyObservers(
        new nsSimpleEnumerator(vCard),
        "user-info-received",
        aJid
      );
    });
  },

  // Parses the photo node of a received vCard if exists and returns string of
  // data URI, otherwise returns null.
  _getPhotoURI(aPhotoNode) {
    if (!aPhotoNode) {
      return null;
    }

    const type = aPhotoNode.getElement(["TYPE"]);
    const value = aPhotoNode.getElement(["BINVAL"]);
    if (!type || !value) {
      return null;
    }

    return "data:" + type.innerText + ";base64," + value.innerText;
  },

  // Parses the vCard into the properties of the returned object.
  parseVCard(aVCardNode) {
    // XEP-0054: vcard-temp.
    const aResult = {};
    for (const node of aVCardNode.children.filter(
      child => child.type == "node"
    )) {
      const localName = node.localName;
      const innerText = node.innerText;
      if (innerText) {
        if (localName == "FN") {
          aResult.fullName = innerText;
        } else if (localName == "NICKNAME") {
          aResult.nickname = innerText;
        } else if (localName == "TITLE") {
          aResult.title = innerText;
        } else if (localName == "BDAY") {
          aResult.birthday = innerText;
        } else if (localName == "JABBERID") {
          aResult.userName = innerText;
        }
      }
      if (localName == "ORG") {
        const organization = node.getElement(["ORGNAME"]);
        if (organization && organization.innerText) {
          aResult.organization = organization.innerText;
        }
      } else if (localName == "EMAIL") {
        const userID = node.getElement(["USERID"]);
        if (userID && userID.innerText) {
          aResult.email = userID.innerText;
        }
      } else if (localName == "ADR") {
        const locality = node.getElement(["LOCALITY"]);
        if (locality && locality.innerText) {
          aResult.locality = locality.innerText;
        }

        const country = node.getElement(["CTRY"]);
        if (country && country.innerText) {
          aResult.country = country.innerText;
        }
      } else if (localName == "PHOTO") {
        aResult.photo = node;
      } else if (localName == "TEL") {
        const number = node.getElement(["NUMBER"]);
        if (number && number.innerText) {
          aResult.telephone = number.innerText;
        }
      }
      // TODO: Parse the other fields of vCard and display it in system messages
      // in response to /whois.
    }
    return aResult;
  },

  // Returns undefined if not an error stanza, and an object
  // describing the error otherwise:
  parseError(aStanza) {
    if (aStanza.attributes.type != "error") {
      return undefined;
    }

    const retval = { stanza: aStanza };
    const error = aStanza.getElement(["error"]);

    // RFC 6120 Section 8.3.2: Type must be one of
    // auth -- retry after providing credentials
    // cancel -- do not retry (the error cannot be remedied)
    // continue -- proceed (the condition was only a warning)
    // modify -- retry after changing the data sent
    // wait -- retry after waiting (the error is temporary).
    retval.type = error.attributes.type;

    // RFC 6120 Section 8.3.3.
    const kDefinedConditions = [
      "bad-request",
      "conflict",
      "feature-not-implemented",
      "forbidden",
      "gone",
      "internal-server-error",
      "item-not-found",
      "jid-malformed",
      "not-acceptable",
      "not-allowed",
      "not-authorized",
      "policy-violation",
      "recipient-unavailable",
      "redirect",
      "registration-required",
      "remote-server-not-found",
      "remote-server-timeout",
      "resource-constraint",
      "service-unavailable",
      "subscription-required",
      "undefined-condition",
      "unexpected-request",
    ];
    let condition = kDefinedConditions.find(c => error.getElement([c]));
    if (!condition) {
      // RFC 6120 Section 8.3.2.
      this.WARN(
        "Nonstandard or missing defined-condition element in error stanza."
      );
      condition = "undefined-condition";
    }
    retval.condition = condition;

    const errortext = error.getElement(["text"]);
    if (errortext) {
      retval.text = errortext.innerText;
    }

    return retval;
  },

  // Returns an error-handling callback for use with sendStanza generated
  // from aHandlers, an object defining the error handlers.
  // If the stanza passed to the callback is an error stanza, it checks if
  // aHandlers contains a property with the name of the defined condition
  // of the error.
  // * If the property is a function, it is called with the parsed error
  //   as its argument, bound to aThis (if provided).
  //   It should return true if the error was handled.
  // * If the property is a string, it is displayed as a system message
  //   in the conversation given by aThis.
  handleErrors(aHandlers, aThis) {
    return aStanza => {
      if (!aHandlers) {
        return false;
      }

      const error = this.parseError(aStanza);
      if (!error) {
        return false;
      }

      const toCamelCase = aStr => {
        // Turn defined condition string into a valid camelcase
        // JS property name.
        const capitalize = s => s[0].toUpperCase() + s.slice(1);
        const uncapitalize = s => s[0].toLowerCase() + s.slice(1);
        return uncapitalize(aStr.split("-").map(capitalize).join(""));
      };
      const condition = toCamelCase(error.condition);
      // Check if we have a handler property for this kind of error or a
      // default handler.
      if (!(condition in aHandlers) && !("default" in aHandlers)) {
        return false;
      }

      // Try to get the handler for condition, if we cannot get it, try to get
      // the default handler.
      let handler = aHandlers[condition];
      if (!handler) {
        handler = aHandlers.default;
      }

      if (typeof handler == "string") {
        // The string is an error message to be displayed in the conversation.
        if (!aThis || !aThis.writeMessage) {
          this.ERROR(
            "HandleErrors was passed an error message string, but " +
              "no conversation to display it in:\n" +
              handler
          );
          return true;
        }
        aThis.writeMessage(aThis.name, handler, { system: true, error: true });
        return true;
      } else if (typeof handler == "function") {
        // If we're given a function, call this error handler.
        return handler.call(aThis, error);
      }

      // If this happens, there's a bug somewhere.
      this.ERROR(
        "HandleErrors was passed a handler for '" +
          condition +
          "'' which is neither a function nor a string."
      );
      return false;
    };
  },

  // Returns a callback suitable for use in sendStanza, to handle type==result
  // responses. aHandlers and aThis are passed on to handleErrors for error
  // handling.
  _handleResult(aHandlers, aThis) {
    return aStanza => {
      if (aStanza.attributes.type == "result") {
        return true;
      }
      return this.handleErrors(aHandlers, aThis)(aStanza);
    };
  },

  /* XMPPSession events */

  /* Called when the XMPP session is started */
  onConnection() {
    // Request the roster. The account will be marked as connected when this is
    // complete.
    this.reportConnecting(
      lazy.l10n.formatValueSync("connection-downloading-roster")
    );
    const s = Stanza.iq(
      "get",
      null,
      null,
      Stanza.node("query", Stanza.NS.roster)
    );
    this.sendStanza(s, this.onRoster, this);

    // XEP-0030 and XEP-0045 (6): Service Discovery.
    // Queries Server for Associated Services.
    let iq = Stanza.iq(
      "get",
      null,
      this._jid.domain,
      Stanza.node("query", Stanza.NS.disco_items)
    );
    this.sendStanza(iq, this.onServiceDiscovery, this);

    // XEP-0030: Service Discovery Information Features.
    iq = Stanza.iq(
      "get",
      null,
      this._jid.domain,
      Stanza.node("query", Stanza.NS.disco_info)
    );
    this.sendStanza(iq, this.onServiceDiscoveryInfo, this);
  },

  /* Called whenever a stanza is received */
  onXmppStanza() {},

  /**
   * Called when an iq stanza is received.
   *
   * @param {XMLNode} aStanza - The IQ stanza.
   */
  onIQStanza(aStanza) {
    const type = aStanza.attributes.type;
    if (type == "set") {
      for (const query of aStanza.getChildren("query")) {
        if (query.uri != Stanza.NS.roster) {
          continue;
        }

        // RFC 6121 2.1.6 (Roster push):
        // A receiving client MUST ignore the stanza unless it has no 'from'
        // attribute (i.e., implicitly from the bare JID of the user's
        // account) or it has a 'from' attribute whose value matches the
        // user's bare JID <user@domainpart>.
        const from = aStanza.attributes.from;
        if (from && from != this._jid.node + "@" + this._jid.domain) {
          this.WARN("Ignoring potentially spoofed roster push.");
          return;
        }

        for (const item of query.getChildren("item")) {
          this._onRosterItem(item, true);
        }
        return;
      }
    } else if (type == "get") {
      const id = aStanza.attributes.id;
      const from = aStanza.attributes.from;

      // XEP-0199: XMPP server-to-client ping (XEP-0199)
      const ping = aStanza.getElement(["ping"]);
      if (ping && ping.uri == Stanza.NS.ping) {
        this.sendStanza(Stanza.iq("result", id, from));
        return;
      }

      const query = aStanza.getElement(["query"]);
      if (query && query.uri == Stanza.NS.version) {
        // XEP-0092: Software Version.
        const children = [];
        children.push(Stanza.node("name", null, null, Services.appinfo.name));
        children.push(
          Stanza.node("version", null, null, Services.appinfo.version)
        );
        const versionQuery = Stanza.node(
          "query",
          Stanza.NS.version,
          null,
          children
        );
        this.sendStanza(Stanza.iq("result", id, from, versionQuery));
        return;
      }
      if (query && query.uri == Stanza.NS.disco_info) {
        // XEP-0030: Service Discovery.
        let children = [];
        if (aStanza.attributes.node == Stanza.NS.muc_rooms) {
          // XEP-0045 (6.7): Room query.
          // TODO: Currently, we return an empty <query/> element, but we
          // should return non-private rooms.
        } else {
          children = SupportedFeatures.map(feature =>
            Stanza.node("feature", null, { var: feature })
          );
          children.unshift(
            Stanza.node("identity", null, {
              category: "client",
              type: "pc",
              name: Services.appinfo.name,
            })
          );
        }
        const discoveryQuery = Stanza.node(
          "query",
          Stanza.NS.disco_info,
          null,
          children
        );
        this.sendStanza(Stanza.iq("result", id, from, discoveryQuery));
        return;
      }
    }
    this.WARN(`Unhandled IQ ${type} stanza.`);
    if (type == "get" || type == "set") {
      // RFC 6120 (section 8.2.3): An entity that receives an IQ request of
      // type "get" or "set" MUST reply with an IQ response of type "result"
      // or "error".
      const id = aStanza.attributes.id;
      const from = aStanza.attributes.from;
      const condition = Stanza.node("service-unavailable", Stanza.NS.stanzas, {
        type: "cancel",
      });
      const error = Stanza.node("error", null, { type: "cancel" }, condition);
      this.sendStanza(Stanza.iq("error", id, from, error));
    }
  },

  /**
   * Called when a presence stanza is received.
   *
   * @param {XMLNode} aStanza - The presence stanza.
   */
  onPresenceStanza(aStanza) {
    const from = aStanza.attributes.from;
    this.DEBUG("Received presence stanza for " + from);

    const jid = this.normalize(from);
    const type = aStanza.attributes.type;
    if (type == "subscribe") {
      this.addBuddyRequest(
        jid,
        this.replyToBuddyRequest.bind(this, "subscribed"),
        this.replyToBuddyRequest.bind(this, "unsubscribed")
      );
    } else if (
      type == "unsubscribe" ||
      type == "unsubscribed" ||
      type == "subscribed"
    ) {
      // Nothing useful to do for these presence stanzas, as we will also
      // receive a roster push containing more or less the same information
    } else if (this._buddies.has(jid)) {
      this._buddies.get(jid).onPresenceStanza(aStanza);
    } else if (this._mucs.has(jid)) {
      this._mucs.get(jid).onPresenceStanza(aStanza);
    } else if (jid != this.normalize(this._connection._jid.jid)) {
      this.WARN("received presence stanza for unknown buddy " + from);
    } else if (
      jid == this._jid.node + "@" + this._jid.domain &&
      this._connection._resource != this._parseJID(from).resource
    ) {
      // Ignore presence stanzas for another resource.
    } else {
      this.WARN("Unhandled presence stanza.");
    }
  },

  // XEP-0030: Discovering services and their features that are supported by
  // the server.
  onServiceDiscovery(aStanza) {
    const query = aStanza.getElement(["query"]);
    if (
      aStanza.attributes.type != "result" ||
      !query ||
      query.uri != Stanza.NS.disco_items
    ) {
      this.LOG("Could not get services for this server: " + this._jid.domain);
      return true;
    }

    // Discovering the Features that are Supported by each service.
    query.getElements(["item"]).forEach(item => {
      const jid = item.attributes.jid;
      if (!jid) {
        return;
      }
      const iq = Stanza.iq(
        "get",
        null,
        jid,
        Stanza.node("query", Stanza.NS.disco_info)
      );
      this.sendStanza(iq, receivedStanza => {
        const stanzaQuery = receivedStanza.getElement(["query"]);
        const from = receivedStanza.attributes.from;
        if (
          aStanza.attributes.type != "result" ||
          !stanzaQuery ||
          stanzaQuery.uri != Stanza.NS.disco_info
        ) {
          this.LOG("Could not get features for this service: " + from);
          return true;
        }
        const features = stanzaQuery
          .getElements(["feature"])
          .map(elt => elt.attributes.var);
        const identity = stanzaQuery.getElement(["identity"]);
        if (
          identity &&
          identity.attributes.category == "conference" &&
          identity.attributes.type == "text" &&
          features.includes(Stanza.NS.muc)
        ) {
          // XEP-0045 (6.2): this feature is for a MUC Service.
          // XEP-0045 (15.2): Service Discovery Category/Type.
          this._mucService = from;
        }
        // TODO: Handle other services that are supported by XMPP through
        // their features.

        return true;
      });
    });
    return true;
  },

  // XEP-0030: Discovering Service Information and its features that are
  // supported by the server.
  onServiceDiscoveryInfo(aStanza) {
    const query = aStanza.getElement(["query"]);
    if (
      aStanza.attributes.type != "result" ||
      !query ||
      query.uri != Stanza.NS.disco_info
    ) {
      this.LOG("Could not get features for this server: " + this._jid.domain);
      return true;
    }

    const features = query
      .getElements(["feature"])
      .map(elt => elt.attributes.var);
    if (features.includes(Stanza.NS.carbons)) {
      // XEP-0280: Message Carbons.
      // Enabling Carbons on server, as it's disabled by default on server.
      if (Services.prefs.getBoolPref("chat.xmpp.messageCarbons")) {
        const iqStanza = Stanza.iq(
          "set",
          null,
          null,
          Stanza.node("enable", Stanza.NS.carbons)
        );
        this.sendStanza(iqStanza, stanza => {
          const error = this.parseError(stanza);
          if (error) {
            this.WARN(
              "Unable to enable message carbons due to " +
                error.condition +
                " error."
            );
            return true;
          }

          const type = stanza.attributes.type;
          if (type != "result") {
            this.WARN(
              "Received unexpected stanza with " +
                type +
                " type " +
                "while enabling message carbons."
            );
            return true;
          }

          this.LOG("Message carbons enabled.");
          this._isCarbonsEnabled = true;
          return true;
        });
      }
    }
    // TODO: Handle other features that are supported by the server.
    return true;
  },

  requestRoomInfo(aCallback) {
    if (this._roomInfoCallbacks.has(aCallback)) {
      return;
    }

    if (this.isRoomInfoStale && !this._pendingList) {
      this._roomList = new Map();
      this._lastListTime = Date.now();
      this._roomInfoCallback = aCallback;
      this._pendingList = true;

      // XEP-0045 (6.3): Discovering Rooms.
      const iq = Stanza.iq(
        "get",
        null,
        this._mucService,
        Stanza.node("query", Stanza.NS.disco_items)
      );
      this.sendStanza(iq, this.onRoomDiscovery, this);
    } else {
      const rooms = [...this._roomList.keys()];
      aCallback.onRoomInfoAvailable(rooms, !this._pendingList);
    }

    if (this._pendingList) {
      this._roomInfoCallbacks.add(aCallback);
    }
  },

  onRoomDiscovery(aStanza) {
    const query = aStanza.getElement(["query"]);
    if (!query || query.uri != Stanza.NS.disco_items) {
      this.LOG("Could not get rooms for this server: " + this._jid.domain);
      return;
    }

    // XEP-0059: Result Set Management.
    const set = query.getElement(["set"]);
    const last = set ? set.getElement(["last"]) : null;
    if (last) {
      const iq = Stanza.iq(
        "get",
        null,
        this._mucService,
        Stanza.node("query", Stanza.NS.disco_items)
      );
      this.sendStanza(iq, this.onRoomDiscovery, this);
    } else {
      this._pendingList = false;
    }

    const rooms = [];
    query.getElements(["item"]).forEach(item => {
      const jid = this._parseJID(item.attributes.jid);
      if (!jid) {
        return;
      }

      let name = item.attributes.name;
      if (!name) {
        name = jid.node ? jid.node : jid.jid;
      }

      this._roomList.set(name, jid.jid);
      rooms.push(name);
    });

    this._roomInfoCallback.onRoomInfoAvailable(rooms, !this._pendingList);
  },

  getRoomInfo(aName) {
    return new XMPPRoomInfo(aName, this);
  },

  // Returns null if not an invitation stanza, and an object
  // describing the invitation otherwise.
  parseInvitation(aStanza) {
    const x = aStanza.getElement(["x"]);
    if (!x) {
      return null;
    }
    const retVal = {
      shouldDecline: false,
    };

    // XEP-0045. Direct Invitation (7.8.1)
    // Described in XEP-0249.
    // jid (chatroom) is required.
    // Password, reason, continue and thread are optional.
    if (x.uri == Stanza.NS.conference) {
      if (!x.attributes.jid) {
        this.WARN("Received an invitation with missing MUC jid.");
        return null;
      }
      retVal.mucJid = this.normalize(x.attributes.jid);
      retVal.from = this.normalize(aStanza.attributes.from);
      retVal.password = x.attributes.password;
      retVal.reason = x.attributes.reason;
      retVal.continue = x.attributes.continue;
      retVal.thread = x.attributes.thread;
      return retVal;
    }

    // XEP-0045. Mediated Invitation (7.8.2)
    // Sent by the chatroom on behalf of someone in the chatroom.
    // jid (chatroom) and from (inviter) are required.
    // password and reason are optional.
    if (x.uri == Stanza.NS.muc_user) {
      const invite = x.getElement(["invite"]);
      if (!invite || !invite.attributes.from) {
        this.WARN("Received an invitation with missing MUC invite or from.");
        return null;
      }
      retVal.mucJid = this.normalize(aStanza.attributes.from);
      retVal.from = this.normalize(invite.attributes.from);
      retVal.shouldDecline = true;
      const continueElement = invite.getElement(["continue"]);
      retVal.continue = !!continueElement;
      if (continueElement) {
        retVal.thread = continueElement.attributes.thread;
      }
      if (x.getElement(["password"])) {
        retVal.password = x.getElement(["password"]).innerText;
      }
      if (invite.getElement(["reason"])) {
        retVal.reason = invite.getElement(["reason"]).innerText;
      }
      return retVal;
    }

    return null;
  },

  /* Called when a message stanza is received */
  onMessageStanza(aStanza) {
    // XEP-0280: Message Carbons.
    // Sending and Receiving Messages.
    // Indicates that the forwarded message was sent or received.
    let isSent = false;
    let carbonStanza =
      aStanza.getElement(["sent"]) || aStanza.getElement(["received"]);
    if (carbonStanza) {
      if (carbonStanza.uri != Stanza.NS.carbons) {
        this.WARN(
          "Received a forwarded message which does not '" +
            Stanza.NS.carbons +
            "' namespace."
        );
        return;
      }

      isSent = carbonStanza.localName == "sent";
      carbonStanza = carbonStanza.getElement(["forwarded", "message"]);
      if (this._isCarbonsEnabled) {
        aStanza = carbonStanza;
      } else {
        this.WARN(
          "Received an unexpected forwarded message while message " +
            "carbons are not enabled."
        );
        return;
      }
    }

    // For forwarded sent messages, we need to use "to" attribute to
    // get the right conversation as from in this case is this account.
    const convJid = isSent ? aStanza.attributes.to : aStanza.attributes.from;

    const normConvJid = this.normalize(convJid);
    const isMuc = this._mucs.has(normConvJid);

    const type = aStanza.attributes.type;
    const x = aStanza.getElement(["x"]);
    let body;
    const b = aStanza.getElement(["body"]);
    if (b) {
      // If there's a <body> child we have more than just typing notifications.
      // Prefer HTML (in <html><body>) and use plain text (<body>) as fallback.
      const htmlBody = aStanza.getElement(["html", "body"]);
      if (htmlBody) {
        body = htmlBody.innerXML;
      } else {
        // Even if the message is in plain text, the prplIMessage
        // should contain a string that's correctly escaped for
        // insertion in an HTML document.
        body = lazy.TXTToHTML(b.innerText);
      }
    }

    const subject = aStanza.getElement(["subject"]);
    // Ignore subject when !isMuc. We're being permissive about subject changes
    // in the comment below, so we need to be careful about where that makes
    // sense. Psi+'s OTR plugin includes a subject and body in its message
    // stanzas.
    if (subject && isMuc) {
      // XEP-0045 (7.2.16): Check for a subject element in the stanza and update
      // the topic if it exists.
      // We are breaking the spec because only a message that contains a
      // <subject/> but no <body/> element shall be considered a subject change
      // for MUC, but we ignore that to be compatible with ejabberd versions
      // before 15.06.
      const muc = this._mucs.get(normConvJid);
      const nick = this._parseJID(convJid).resource;
      // TODO There can be multiple subject elements with different xml:lang
      // attributes.
      muc.setTopic(subject.innerText, nick);
      return;
    }

    const invitation = this.parseInvitation(aStanza);
    if (invitation) {
      let messageID;
      const fluentParams = {
        inviter: invitation.from,
        room: invitation.mucJid,
      };
      if (invitation.reason) {
        messageID = "conversation-muc-invitation-with-reason2";
        fluentParams.reason = invitation.reason;
      } else {
        messageID = "conversation-muc-invitation-without-reason";
      }
      if (invitation.password) {
        messageID += "-password";
        fluentParams.password = invitation.password;
      }
      const message = lazy.l10n.formatValueSync(messageID, fluentParams);

      this.addChatRequest(
        invitation.mucJid,
        () => {
          const chatRoomFields = this.getChatRoomFieldValuesFromString(
            invitation.mucJid
          );
          if (invitation.password) {
            chatRoomFields.setValue("password", invitation.password);
          }
          const muc = this.joinChat(chatRoomFields);
          muc.writeMessage(muc.name, message, { system: true });
        },
        (request, tryToDeny) => {
          // Only mediated invitations (XEP-0045) can explicitly decline.
          if (invitation.shouldDecline && tryToDeny) {
            const decline = Stanza.node(
              "decline",
              null,
              { from: invitation.from },
              null
            );
            const x2 = Stanza.node("x", Stanza.NS.muc_user, null, decline);
            const s = Stanza.node(
              "message",
              null,
              { to: invitation.mucJid },
              x2
            );
            this.sendStanza(s);
          }
          // Always show invite reason or password, even if the invite wasn't
          // automatically declined based on the setting.
          if (!request || invitation.reason || invitation.password) {
            const conv = this.createConversation(invitation.from);
            if (conv) {
              conv.writeMessage(invitation.from, message, { system: true });
            }
          }
        }
      );
    }

    if (body) {
      const date = _getDelay(aStanza);
      if (
        type == "groupchat" ||
        (type == "error" && isMuc && !this._conv.has(convJid))
      ) {
        if (!isMuc) {
          this.WARN(
            "Received a groupchat message for unknown MUC " + normConvJid
          );
          return;
        }
        const muc = this._mucs.get(normConvJid);
        muc.incomingMessage(body, aStanza, date);
        return;
      }

      const conv = this.createConversation(convJid);
      if (!conv) {
        return;
      }

      if (isSent) {
        _displaySentMsg(conv, body, date);
        return;
      }
      conv.incomingMessage(body, aStanza, date);
    } else if (type == "error") {
      const conv = this.createConversation(convJid);
      if (conv) {
        conv.incomingMessage(null, aStanza);
      }
    } else if (x && x.uri == Stanza.NS.muc_user) {
      const muc = this._mucs.get(normConvJid);
      if (!muc) {
        this.WARN(
          "Received a groupchat message for unknown MUC " + normConvJid
        );
        return;
      }
      muc.onMessageStanza(aStanza);
      return;
    }

    // If this is a sent message carbon, the user is typing on another client.
    if (isSent) {
      return;
    }

    // Don't create a conversation to only display the typing notifications.
    if (!this._conv.has(normConvJid) && !this._conv.has(convJid)) {
      return;
    }

    // Ignore errors while delivering typing notifications.
    if (type == "error") {
      return;
    }

    let typingState = Ci.prplIConvIM.NOT_TYPING;
    let state;
    const s = aStanza.getChildrenByNS(Stanza.NS.chatstates);
    if (s.length > 0) {
      state = s[0].localName;
    }
    if (state) {
      this.DEBUG(state);
      if (state == "composing") {
        typingState = Ci.prplIConvIM.TYPING;
      } else if (state == "paused") {
        typingState = Ci.prplIConvIM.TYPED;
      }
    }
    let convName = normConvJid;

    // If the bare JID is a MUC that we have joined, use the full JID as this
    // is a private message to a MUC participant.
    if (isMuc) {
      convName = convJid;
    }

    const conv = this._conv.get(convName);
    if (!conv) {
      return;
    }
    conv.updateTyping(typingState, conv.shortName);
    conv.supportChatStateNotifications = !!state;
  },

  /** Called when there is an error in the XMPP session */
  onError(aError, aException) {
    if (aError === null || aError === undefined) {
      aError = Ci.prplIAccount.ERROR_OTHER_ERROR;
    }
    this._disconnect(aError, aException.toString());
  },

  onVCard(aStanza) {
    const jid = this._pendingVCardRequests.shift();
    this._requestNextVCard();
    if (!this._buddies.has(jid) && !this._mucs.has(jid)) {
      this.WARN("Received a vCard for unknown buddy " + jid);
      return;
    }

    const vCard = aStanza.getElement(["vCard"]);
    const error = this.parseError(aStanza);
    if (
      (error &&
        (error.condition == "item-not-found" ||
          error.condition == "service-unavailable")) ||
      !vCard ||
      !vCard.children.length
    ) {
      this.LOG("No vCard exists (or the user does not exist) for " + jid);
      return;
    } else if (error) {
      this.WARN("Received unexpected vCard error " + error.condition);
      return;
    }

    const stanzaJid = this.normalize(aStanza.attributes.from);
    if (jid && jid != stanzaJid) {
      this.ERROR(
        "Received vCard for a different jid (" +
          stanzaJid +
          ") " +
          "than the requested " +
          jid
      );
    }

    let foundFormattedName = false;
    const vCardInfo = this.parseVCard(vCard);
    if (this._mucs.has(jid)) {
      const conv = this._mucs.get(jid);
      if (vCardInfo.photo) {
        conv._saveIcon(vCardInfo.photo);
      }
      return;
    }
    const buddy = this._buddies.get(jid);
    if (vCardInfo.fullName) {
      buddy.vCardFormattedName = vCardInfo.fullName;
      foundFormattedName = true;
    }
    if (vCardInfo.photo) {
      buddy._saveIcon(vCardInfo.photo);
    }
    if (!foundFormattedName && buddy._vCardFormattedName) {
      buddy.vCardFormattedName = "";
    }
    buddy._vCardReceived = true;
  },

  /**
   * Save the icon for a resource to the local file system.
   *
   * @param {Node} photo - The vcard photo node representing the icon.
   * @param {prplIChatBuddy|prplIConversation} resource - Resource the icon is for.
   * @returns {Promise<string>} Resolves with the file:// URI to the local icon file.
   */
  _saveResourceIcon(photo, resource) {
    // Some servers seem to send a photo node without a type declared.
    let type = photo.getElement(["TYPE"]);
    if (!type) {
      return Promise.reject(new Error("Missing image type"));
    }
    type = type.innerText;
    const kExt = {
      "image/gif": "gif",
      "image/jpeg": "jpg",
      "image/png": "png",
    };
    if (!kExt.hasOwnProperty(type)) {
      return Promise.reject(new Error("Unknown image type"));
    }

    let content = "",
      data = "";
    // Strip all characters not allowed in base64 before parsing.
    const parseBase64 = aBase => atob(aBase.replace(/[^A-Za-z0-9\+\/\=]/g, ""));
    for (const line of photo.getElement(["BINVAL"]).innerText.split("\n")) {
      data += line;
      // Mozilla's atob() doesn't handle padding with "=" or "=="
      // unless it's at the end of the string, so we have to work around that.
      if (line.endsWith("=")) {
        content += parseBase64(data);
        data = "";
      }
    }
    content += parseBase64(data);

    // Store a sha1 hash of the photo we have just received.
    const ch = Cc["@mozilla.org/security/hash;1"].createInstance(
      Ci.nsICryptoHash
    );
    ch.init(ch.SHA1);
    const dataArray = Object.keys(content).map(i => content.charCodeAt(i));
    ch.update(dataArray, dataArray.length);
    const hash = ch.finish(false);
    function toHexString(charCode) {
      return charCode.toString(16).padStart(2, "0");
    }
    resource._photoHash = Object.keys(hash)
      .map(i => toHexString(hash.charCodeAt(i)))
      .join("");

    const istream = Cc["@mozilla.org/io/string-input-stream;1"].createInstance(
      Ci.nsIStringInputStream
    );
    istream.setByteStringData(content);

    const fileName = resource._photoHash + "." + kExt[type];
    const file = new lazy.FileUtils.File(
      PathUtils.join(
        PathUtils.profileDir,
        "icons",
        this.protocol.normalizedName,
        this.normalizedName,
        fileName
      )
    );
    const ostream = lazy.FileUtils.openSafeFileOutputStream(file);
    return new Promise(resolve => {
      lazy.NetUtil.asyncCopy(istream, ostream, rc => {
        if (Components.isSuccessCode(rc)) {
          resolve(Services.io.newFileURI(file).spec);
        }
      });
    });
  },

  _requestNextVCard() {
    if (!this._pendingVCardRequests.length) {
      return;
    }
    const s = Stanza.iq(
      "get",
      null,
      this._pendingVCardRequests[0],
      Stanza.node("vCard", Stanza.NS.vcard)
    );
    this.sendStanza(s, this.onVCard, this);
  },

  _addVCardRequest(aJID) {
    const requestPending = !!this._pendingVCardRequests.length;
    this._pendingVCardRequests.push(aJID);
    if (!requestPending) {
      this._requestNextVCard();
    }
  },

  // XEP-0029 (Section 2) and RFC 6122 (Section 2): The node and domain are
  // lowercase, while resources are case sensitive and can contain spaces.
  normalizeFullJid(aJID) {
    return this._parseJID(aJID.trim()).jid;
  },

  // Standard normalization for XMPP removes the resource part of jids.
  normalize(aJID) {
    return aJID
      .trim()
      .split("/", 1)[0] // up to first slash
      .toLowerCase();
  },

  // RFC 6122 (Section 2): [ localpart "@" ] domainpart [ "/" resourcepart ] is
  // the form of jid.
  // Localpart is parsed as node and optional.
  // Domainpart is parsed as domain and required.
  // resourcepart is parsed as resource and optional.
  _parseJID(aJid) {
    const match = /^(?:([^"&'/:<>@]+)@)?([^@/<>'\"]+)(?:\/(.*))?$/.exec(
      aJid.trim()
    );
    if (!match) {
      return null;
    }

    const result = {
      node: match[1],
      domain: match[2].toLowerCase(),
      resource: match[3],
    };
    return this._setJID(result.domain, result.node, result.resource);
  },

  // Constructs jid as an object from domain, node and resource parts.
  // The object has properties (node, domain, resource and jid).
  // aDomain is required, but aNode and aResource are optional.
  _setJID(aDomain, aNode = null, aResource = null) {
    if (!aDomain) {
      throw new Error("aDomain must have a value");
    }

    const result = {
      node: aNode,
      domain: aDomain.toLowerCase(),
      resource: aResource,
    };
    let jid = result.domain;
    if (result.node) {
      result.node = result.node.toLowerCase();
      jid = result.node + "@" + jid;
    }
    if (result.resource) {
      jid += "/" + result.resource;
    }
    result.jid = jid;
    return result;
  },

  _onRosterItem(aItem, aNotifyOfUpdates) {
    let jid = aItem.attributes.jid;
    if (!jid) {
      this.WARN("Received a roster item without jid: " + aItem.getXML());
      return "";
    }
    jid = this.normalize(jid);

    let subscription = "";
    if ("subscription" in aItem.attributes) {
      subscription = aItem.attributes.subscription;
    }
    if (subscription == "remove") {
      this._forgetRosterItem(jid);
      return "";
    }

    let buddy;
    if (this._buddies.has(jid)) {
      buddy = this._buddies.get(jid);
      const groups = aItem.getChildren("group");
      if (groups.length) {
        // If the server specified at least one group, ensure the group we use
        // as the account buddy's tag is still a group on the server...
        let tagName = buddy.tag.name;
        if (!groups.some(g => g.innerText == tagName)) {
          // ... otherwise we need to move our account buddy to a new group.
          tagName = groups[0].innerText;
          if (tagName) {
            // Should always be true, but check just in case...
            const oldTag = buddy.tag;
            buddy._tag = IMServices.tags.createTag(tagName);
            IMServices.contacts.accountBuddyMoved(buddy, oldTag, buddy._tag);
          }
        }
      }
    } else {
      let tag;
      for (const group of aItem.getChildren("group")) {
        const name = group.innerText;
        if (name) {
          tag = IMServices.tags.createTag(name);
          break; // TODO we should create an accountBuddy per group,
          // but this._buddies would probably not like that...
        }
      }
      buddy = new this._accountBuddyConstructor(
        this,
        null,
        tag || IMServices.tags.defaultTag,
        jid
      );
    }

    // We request the vCard only if we haven't received it yet and are
    // subscribed to presence for that contact.
    if (
      (subscription == "both" || subscription == "to") &&
      !buddy._vCardReceived
    ) {
      this._addVCardRequest(jid);
    }

    const alias = "name" in aItem.attributes ? aItem.attributes.name : "";
    if (alias) {
      if (aNotifyOfUpdates && this._buddies.has(jid)) {
        buddy.rosterAlias = alias;
      } else {
        buddy._rosterAlias = alias;
      }
    } else if (buddy._rosterAlias) {
      buddy.rosterAlias = "";
    }

    if (subscription) {
      buddy.subscription = subscription;
    }
    if (!this._buddies.has(jid)) {
      this._buddies.set(jid, buddy);
      IMServices.contacts.accountBuddyAdded(buddy);
    } else if (aNotifyOfUpdates) {
      buddy._notifyObservers("status-detail-changed");
    }

    // Keep the xml nodes of the item so that we don't have to
    // recreate them when changing something (eg. the alias) in it.
    buddy._rosterItem = aItem;

    return jid;
  },
  _forgetRosterItem(aJID) {
    IMServices.contacts.accountBuddyRemoved(this._buddies.get(aJID));
    this._buddies.delete(aJID);
  },

  /* When the roster is received */
  onRoster(aStanza) {
    // For the first element that is a roster stanza.
    for (const qe of aStanza.getChildren("query")) {
      if (qe.uri != Stanza.NS.roster) {
        continue;
      }

      // Find all the roster items in the new message.
      const newRoster = new Set();
      for (const item of qe.getChildren("item")) {
        const jid = this._onRosterItem(item);
        if (jid) {
          newRoster.add(jid);
        }
      }
      // If an item was in the old roster, but not in the new, forget it.
      for (const jid of this._buddies.keys()) {
        if (!newRoster.has(jid)) {
          this._forgetRosterItem(jid);
        }
      }
      break;
    }

    this._sendPresence();
    this._buddies.forEach(b => {
      if (b.subscription == "both" || b.subscription == "to") {
        b.setStatus(Ci.imIStatusInfo.STATUS_OFFLINE, "");
      }
    });
    this.reportConnected();
    this._sendVCard();
  },

  /* Public methods */

  sendStanza(aStanza, aCallback, aThis, aLogString) {
    return this._connection.sendStanza(aStanza, aCallback, aThis, aLogString);
  },

  // Variations of the XMPP protocol can change these default constructors:
  _conversationConstructor: XMPPConversation,
  _MUCConversationConstructor: XMPPMUCConversation,
  _accountBuddyConstructor: XMPPAccountBuddy,

  /* Create a new conversation */
  createConversation(aName) {
    let convName = this.normalize(aName);

    // Checks if conversation is with a participant of a MUC we are in. We do
    // not want to strip the resource as it is of the form room@domain/nick.
    const isMucParticipant = this._mucs.has(convName);
    if (isMucParticipant) {
      convName = this.normalizeFullJid(aName);
    }

    // Checking that the aName can be parsed and is not broken.
    const jid = this._parseJID(convName);
    if (
      !jid ||
      !jid.domain ||
      (isMucParticipant && (!jid.node || !jid.resource))
    ) {
      this.ERROR("Could not create conversation as jid is broken: " + convName);
      throw new Error("Invalid JID");
    }

    if (!this._conv.has(convName)) {
      this._conv.set(
        convName,
        new this._conversationConstructor(this, convName, isMucParticipant)
      );
    }

    return this._conv.get(convName);
  },

  /* Remove an existing conversation */
  removeConversation(aNormalizedName) {
    if (this._conv.has(aNormalizedName)) {
      this._conv.delete(aNormalizedName);
    } else if (this._mucs.has(aNormalizedName)) {
      this._mucs.delete(aNormalizedName);
    }
  },

  /* Private methods */

  /**
   * Disconnect from the server
   *
   * @param {number} aError - The error reason, passed to reportDisconnecting.
   * @param {string} aErrorMessage - The error message, passed to reportDisconnecting.
   * @param {boolean} aQuiet - True to avoid sending status change notifications
   *   during the uninitialization of the account.
   */
  _disconnect(
    aError = Ci.prplIAccount.NO_ERROR,
    aErrorMessage = "",
    aQuiet = false
  ) {
    if (!this._connection) {
      return;
    }

    this.reportDisconnecting(aError, aErrorMessage);

    this._buddies.forEach(b => {
      if (!aQuiet) {
        b.setStatus(Ci.imIStatusInfo.STATUS_UNKNOWN, "");
      }
      b.onAccountDisconnected();
    });

    this._mucs.forEach(muc => {
      muc.joining = false; // In case we never finished joining.
      muc.left = true;
    });

    this._connection.disconnect();
    delete this._connection;

    // We won't receive "user-icon-changed" notifications while the
    // account isn't connected, so clear the cache to avoid keeping an
    // obsolete icon.
    delete this._cachedUserIcon;
    // Also clear the cached user vCard, as we will want to redownload it
    // after reconnecting.
    delete this._userVCard;

    // Clear vCard requests.
    this._pendingVCardRequests = [];

    this.reportDisconnected();
  },

  /* Set the user status on the server */
  _sendPresence() {
    delete this._shouldSendPresenceForIdlenessChange;

    if (!this._connection) {
      return;
    }

    const si = this.imAccount.statusInfo;
    const statusType = si.statusType;
    let show = "";
    if (statusType == Ci.imIStatusInfo.STATUS_UNAVAILABLE) {
      show = "dnd";
    } else if (
      statusType == Ci.imIStatusInfo.STATUS_AWAY ||
      statusType == Ci.imIStatusInfo.STATUS_IDLE
    ) {
      show = "away";
    }
    const children = [];
    if (show) {
      children.push(Stanza.node("show", null, null, show));
    }
    const statusText = si.statusText;
    if (statusText) {
      children.push(Stanza.node("status", null, null, statusText));
    }
    if (this._idleSince) {
      const time = Math.floor(Date.now() / 1000) - this._idleSince;
      children.push(Stanza.node("query", Stanza.NS.last, { seconds: time }));
    }
    if (this.prefs.prefHasUserValue("priority")) {
      const priority = Math.max(-128, Math.min(127, this.getInt("priority")));
      if (priority) {
        children.push(Stanza.node("priority", null, null, priority.toString()));
      }
    }
    this.sendStanza(Stanza.presence({ "xml:lang": "en" }, children), () => {
      // As we are implicitly subscribed to our own presence (rfc6121#4), we
      // will receive the presence stanza mirrored back to us. We don't need
      // to do anything with this response.
      return true;
    });
  },

  _downloadingUserVCard: false,
  _downloadUserVCard() {
    // If a download is already in progress, don't start another one.
    if (this._downloadingUserVCard) {
      return;
    }
    this._downloadingUserVCard = true;
    const s = Stanza.iq(
      "get",
      null,
      null,
      Stanza.node("vCard", Stanza.NS.vcard)
    );
    this.sendStanza(s, this.onUserVCard, this);
  },

  onUserVCard(aStanza) {
    delete this._downloadingUserVCard;
    const userVCard = aStanza.getElement(["vCard"]) || null;
    if (userVCard) {
      // Strip any server-specific namespace off the incoming vcard
      // before storing it.
      this._userVCard = Stanza.node(
        "vCard",
        Stanza.NS.vcard,
        null,
        userVCard.children
      );
    }

    // If a user icon exists in the vCard we received from the server,
    // we need to ensure the line breaks in its binval are exactly the
    // same as those we would include if we sent the icon, and that
    // there isn't any other whitespace.
    if (this._userVCard) {
      let binval = this._userVCard.getElement(["PHOTO", "BINVAL"]);
      if (binval && binval.children.length) {
        binval = binval.children[0];
        binval.text = binval.text
          .replace(/[^A-Za-z0-9\+\/\=]/g, "")
          .replace(/.{74}/g, "$&\n");
      }
    } else {
      // Downloading the vCard failed.
      if (
        this.handleErrors({
          itemNotFound: () => false, // OK, no vCard exists yet.
          default: () => true,
        })(aStanza)
      ) {
        this.WARN(
          "Unexpected error retrieving the user's vcard, " +
            "so we won't attempt to set it either."
        );
        return;
      }
      // Set this so that we don't get into an infinite loop trying to download
      // the vcard again. The check in sendVCard is for hasOwnProperty.
      this._userVCard = null;
    }
    this._sendVCard();
  },

  _cachingUserIcon: false,
  _cacheUserIcon() {
    if (this._cachingUserIcon) {
      return;
    }

    const userIcon = this.imAccount.statusInfo.getUserIcon();
    if (!userIcon) {
      this._cachedUserIcon = null;
      this._sendVCard();
      return;
    }

    this._cachingUserIcon = true;
    const channel = lazy.NetUtil.newChannel({
      uri: userIcon,
      loadingPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
      securityFlags:
        Ci.nsILoadInfo.SEC_REQUIRE_SAME_ORIGIN_INHERITS_SEC_CONTEXT,
      contentPolicyType: Ci.nsIContentPolicy.TYPE_IMAGE,
    });
    lazy.NetUtil.asyncFetch(channel, (inputStream, resultCode) => {
      if (!Components.isSuccessCode(resultCode)) {
        return;
      }
      try {
        let type = channel.contentType;
        const buffer = lazy.NetUtil.readInputStreamToString(
          inputStream,
          inputStream.available()
        );
        const readImage = lazy.imgTools.decodeImageFromBuffer(
          buffer,
          buffer.length,
          type
        );
        let scaledImage;
        if (readImage.width <= 96 && readImage.height <= 96) {
          scaledImage = lazy.imgTools.encodeImage(readImage, type);
        } else {
          if (type != "image/jpeg") {
            type = "image/png";
          }
          scaledImage = lazy.imgTools.encodeScaledImage(
            readImage,
            type,
            64,
            64
          );
        }

        const bstream = Cc["@mozilla.org/binaryinputstream;1"].createInstance(
          Ci.nsIBinaryInputStream
        );
        bstream.setInputStream(scaledImage);

        const data = bstream.readBytes(bstream.available());
        this._cachedUserIcon = {
          type,
          binval: btoa(data).replace(/.{74}/g, "$&\n"),
        };
      } catch (e) {
        console.error(e);
        this._cachedUserIcon = null;
      }
      delete this._cachingUserIcon;
      this._sendVCard();
    });
  },
  _sendVCard() {
    if (!this._connection) {
      return;
    }

    // We have to download the user's existing vCard before updating it.
    // This lets us preserve the fields that we don't change or don't know.
    // Some servers may reject a new vCard if we don't do this first.
    if (!this.hasOwnProperty("_userVCard")) {
      // The download of the vCard is asynchronous and will call _sendVCard back
      // when the user's vCard has been received.
      this._downloadUserVCard();
      return;
    }

    // Read the local user icon asynchronously from the disk.
    // _cacheUserIcon will call _sendVCard back once the icon is ready.
    if (!this.hasOwnProperty("_cachedUserIcon")) {
      this._cacheUserIcon();
      return;
    }

    // If the user currently doesn't have any vCard on the server or
    // the download failed, an empty new one.
    if (!this._userVCard) {
      this._userVCard = Stanza.node("vCard", Stanza.NS.vcard);
    }

    // Keep a serialized copy of the existing user vCard so that we
    // can avoid resending identical data to the server.
    const existingVCard = this._userVCard.getXML();

    const fn = this._userVCard.getElement(["FN"]);
    const displayName = this.imAccount.statusInfo.displayName;
    if (displayName) {
      // If a display name is set locally, update or add an FN field to the vCard.
      if (!fn) {
        this._userVCard.addChild(
          Stanza.node("FN", Stanza.NS.vcard, null, displayName)
        );
      } else if (fn.children.length) {
        fn.children[0].text = displayName;
      } else {
        fn.addText(displayName);
      }
    } else if ("_forceUserDisplayNameUpdate" in this) {
      // We remove a display name stored on the server without replacing
      // it with a new value only if this _sendVCard call is the result of
      // a user action. This is to avoid removing data from the server each
      // time the user connects from a new profile.
      this._userVCard.children = this._userVCard.children.filter(
        n => n.qName != "FN"
      );
    }
    delete this._forceUserDisplayNameUpdate;

    if (this._cachedUserIcon) {
      // If we have a local user icon, update or add it in the PHOTO field.
      const photoChildren = [
        Stanza.node("TYPE", Stanza.NS.vcard, null, this._cachedUserIcon.type),
        Stanza.node(
          "BINVAL",
          Stanza.NS.vcard,
          null,
          this._cachedUserIcon.binval
        ),
      ];
      const photo = this._userVCard.getElement(["PHOTO"]);
      if (photo) {
        photo.children = photoChildren;
      } else {
        this._userVCard.addChild(
          Stanza.node("PHOTO", Stanza.NS.vcard, null, photoChildren)
        );
      }
    } else if ("_forceUserIconUpdate" in this) {
      // Like for the display name, we remove a photo without
      // replacing it only if the call is caused by a user action.
      this._userVCard.children = this._userVCard.children.filter(
        n => n.qName != "PHOTO"
      );
    }
    delete this._forceUserIconUpdate;

    // Send the vCard only if it has really changed.
    // We handle the result response from the server (it does not require
    // any further action).
    if (this._userVCard.getXML() != existingVCard) {
      this.sendStanza(
        Stanza.iq("set", null, null, this._userVCard),
        this._handleResult()
      );
    } else {
      this.LOG(
        "Not sending the vCard because the server stored vCard is identical."
      );
    }
  },
};
