/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { MailServices } from "resource:///modules/MailServices.sys.mjs";

import { MimeMultiPart, MimePart } from "resource:///modules/MimePart.sys.mjs";
import { MsgUtils } from "resource:///modules/MimeMessageUtils.sys.mjs";
import { jsmime } from "resource:///modules/jsmime.sys.mjs";

/**
 * A class to create a top MimePart and write to a tmp file. It works like this:
 * 1. collect top level MIME headers (_gatherMimeHeaders)
 * 2. collect HTML/plain main body as MimePart[] (_gatherMainParts)
 * 3. collect attachments as MimePart[] (_gatherAttachmentParts)
 * 4. construct a top MimePart with above headers and MimePart[] (_initMimePart)
 * 5. write the top MimePart to a tmp file (createMessageFile)
 * NOTE: It's possible we will want to replace nsIMsgSend with the interfaces of
 * MimeMessage. As a part of it, we will add a `send` method to this class.
 */
export class MimeMessage {
  /**
   * Construct a MimeMessage.
   *
   * @param {nsIMsgIdentity} userIdentity
   * @param {nsIMsgCompFields} compFields
   * @param {string} fcc - The FCC header value.
   * @param {string} bodyType
   * @param {BinaryString} bodyText - This is ensured to be a 8-bit string, to
   *   be handled the same as attachment content.
   * @param {nsMsgDeliverMode} deliverMode
   * @param {string} originalMsgURI
   * @param {MSG_ComposeType} compType
   * @param {nsIMsgAttachment[]} embeddedAttachments - Usually Embedded images.
   * @param {nsIMsgSendReport} sendReport - Used by _startCryptoEncapsulation.
   */
  constructor(
    userIdentity,
    compFields,
    fcc,
    bodyType,
    bodyText,
    deliverMode,
    originalMsgURI,
    compType,
    embeddedAttachments,
    sendReport
  ) {
    this._userIdentity = userIdentity;
    this._compFields = compFields;
    this._fcc = fcc;
    this._bodyType = bodyType;
    this._bodyText = bodyText;
    this._deliverMode = deliverMode;
    this._compType = compType;
    this._embeddedAttachments = embeddedAttachments;
    this._sendReport = sendReport;
  }

  /**
   * Write a MimeMessage to a tmp file.
   *
   * @returns {nsIFile}
   */
  async createMessageFile() {
    const topPart = this._initMimePart();
    const file = Services.dirsvc.get("TmpD", Ci.nsIFile);
    file.append("nsemail.eml");
    file.createUnique(Ci.nsIFile.NORMAL_FILE_TYPE, 0o600);

    const fstream = Cc[
      "@mozilla.org/network/file-output-stream;1"
    ].createInstance(Ci.nsIFileOutputStream);
    this._fstream = Cc[
      "@mozilla.org/network/buffered-output-stream;1"
    ].createInstance(Ci.nsIBufferedOutputStream);
    fstream.init(file, -1, -1, 0);
    this._fstream.init(fstream, 16 * 1024);

    this._composeSecure = this._getComposeSecure();
    if (this._composeSecure) {
      await this._writePart(topPart);
      this._composeSecure.finishCryptoEncapsulation(false, this._sendReport);
    } else {
      await this._writePart(topPart);
    }

    this._fstream.close();
    fstream.close();

    return file;
  }

  /**
   * Create a top MimePart to represent the full message.
   *
   * @returns {MimePart}
   */
  _initMimePart() {
    const { plainPart, htmlPart } = this._gatherMainParts();
    const embeddedParts = this._gatherEmbeddedParts();
    const attachmentParts = this._gatherAttachmentParts();

    let relatedPart = htmlPart;
    if (htmlPart && embeddedParts.length > 0) {
      relatedPart = new MimeMultiPart("related");
      relatedPart.addPart(htmlPart);
      relatedPart.addParts(embeddedParts);
    }
    const mainParts = [plainPart, relatedPart].filter(Boolean);
    let topPart;
    if (attachmentParts.length > 0) {
      // Use multipart/mixed as long as there is at least one attachment.
      topPart = new MimeMultiPart("mixed");
      if (plainPart && relatedPart) {
        // Wrap mainParts inside a multipart/alternative MimePart.
        const alternativePart = new MimeMultiPart("alternative");
        alternativePart.addParts(mainParts);
        topPart.addPart(alternativePart);
      } else {
        topPart.addParts(mainParts);
      }
      topPart.addParts(attachmentParts);
    } else {
      if (mainParts.length > 1) {
        // Mark the topPart as multipart/alternative.
        topPart = new MimeMultiPart("alternative");
      } else {
        topPart = new MimePart();
      }
      topPart.addParts(mainParts);
    }

    topPart.setHeaders(this._gatherMimeHeaders());

    return topPart;
  }

  /**
   * Collect top level headers like From/To/Subject into a Map.
   *
   * @returns {Map<string,*>} headers to value mapping.
   */
  _gatherMimeHeaders() {
    let messageId = this._compFields.messageId;
    if (
      !messageId &&
      (this._compFields.to ||
        this._compFields.cc ||
        this._compFields.bcc ||
        !this._compFields.newsgroups ||
        this._userIdentity.getBoolAttribute("generate_news_message_id"))
    ) {
      // Try to use the domain name of the From header to generate the Message-ID. We
      // specifically don't use the nsIMsgIdentity associated with the account, because
      // the user might have changed the address in the From header to use a different
      // domain, and we don't want to leak the relationship between the domains.
      const fromHdr = MailServices.headerParser.parseEncodedHeaderW(
        this._compFields.from
      );

      // Extract the hostname from the address, if any, and generate a
      // Message-ID from it.
      const hostname = fromHdr[0]?.email.replace(/.*@/, "");
      messageId = Cc["@mozilla.org/messengercompose/computils;1"]
        .createInstance(Ci.nsIMsgCompUtils)
        .msgGenerateMessageId(this._userIdentity, hostname);

      this._compFields.messageId = messageId;
    }
    const headers = new Map([
      ["message-id", messageId],
      ["date", new Date()],
      ["mime-version", "1.0"],
    ]);

    if (Services.prefs.getBoolPref("mailnews.headers.sendUserAgent")) {
      if (Services.prefs.getBoolPref("mailnews.headers.useMinimalUserAgent")) {
        headers.set(
          "user-agent",
          Services.strings
            .createBundle("chrome://branding/locale/brand.properties")
            .GetStringFromName("brandFullName")
        );
      } else {
        headers.set(
          "user-agent",
          Cc["@mozilla.org/network/protocol;1?name=http"].getService(
            Ci.nsIHttpProtocolHandler
          ).userAgent
        );
      }
    }

    for (const headerName of [...this._compFields.headerNames]) {
      const headerContent = this._compFields.getRawHeader(headerName);
      if (headerContent) {
        headers.set(headerName, headerContent);
      }
    }
    const isDraft = [
      Ci.nsIMsgSend.nsMsgQueueForLater,
      Ci.nsIMsgSend.nsMsgDeliverBackground,
      Ci.nsIMsgSend.nsMsgSaveAsDraft,
      Ci.nsIMsgSend.nsMsgSaveAsTemplate,
    ].includes(this._deliverMode);

    const undisclosedRecipients = MsgUtils.getUndisclosedRecipients(
      this._compFields,
      this._deliverMode
    );
    if (undisclosedRecipients) {
      headers.set("to", undisclosedRecipients);
    }

    if (isDraft) {
      headers
        .set(
          "x-mozilla-draft-info",
          MsgUtils.getXMozillaDraftInfo(this._compFields)
        )
        .set("x-identity-key", this._userIdentity.key)
        .set("fcc", this._fcc);
    }

    if (messageId) {
      // MDN request header requires to have MessageID header presented in the
      // message in order to coorelate the MDN reports to the original message.
      headers
        .set(
          "disposition-notification-to",
          MsgUtils.getDispositionNotificationTo(
            this._compFields,
            this._deliverMode
          )
        )
        .set(
          "return-receipt-to",
          MsgUtils.getReturnReceiptTo(this._compFields, this._deliverMode)
        );
    }

    for (const { headerName, headerValue } of MsgUtils.getDefaultCustomHeaders(
      this._userIdentity
    )) {
      headers.set(headerName, headerValue);
    }

    const rawMftHeader = headers.get("mail-followup-to");
    // If there's already a Mail-Followup-To header, don't need to do anything.
    if (!rawMftHeader) {
      headers.set(
        "mail-followup-to",
        MsgUtils.getMailFollowupToHeader(this._compFields, this._userIdentity)
      );
    }

    const rawMrtHeader = headers.get("mail-reply-to");
    // If there's already a Mail-Reply-To header, don't need to do anything.
    if (!rawMrtHeader) {
      headers.set(
        "mail-reply-to",
        MsgUtils.getMailReplyToHeader(
          this._compFields,
          this._userIdentity,
          rawMrtHeader
        )
      );
    }

    const rawPriority = headers.get("x-priority");
    if (rawPriority) {
      headers.set("x-priority", MsgUtils.getXPriority(rawPriority));
    }

    const rawReferences = headers.get("references");
    if (rawReferences) {
      const references = MsgUtils.getReferences(rawReferences);
      // Don't reset the "References" header if references is undefined.
      if (references) {
        headers.set("references", references);
      }
      if (!headers.has("in-reply-to")) {
        headers.set("in-reply-to", MsgUtils.getInReplyTo(rawReferences));
      }
    }
    if (
      rawReferences &&
      [
        Ci.nsIMsgCompType.ForwardInline,
        Ci.nsIMsgCompType.ForwardAsAttachment,
      ].includes(this._compType)
    ) {
      headers.set("x-forwarded-message-id", rawReferences);
    }

    return headers;
  }

  /**
   * Determine if the message should include an HTML part, a plain part or both.
   *
   * @returns {{plainPart: MimePart, htmlPart: MimePart}}
   */
  _gatherMainParts() {
    const formatFlowed = Services.prefs.getBoolPref(
      "mailnews.send_plaintext_flowed"
    );
    let formatParam = "";
    if (formatFlowed) {
      // Set format=flowed as in RFC 2646 according to the preference.
      formatParam += "; format=flowed";
    }

    let htmlPart = null;
    let plainPart = null;
    const parts = {};

    if (this._bodyType === "text/html") {
      htmlPart = new MimePart(
        this._bodyType,
        this._compFields.forceMsgEncoding,
        true
      );
      htmlPart.setHeader("content-type", "text/html; charset=UTF-8");
      htmlPart.bodyText = this._bodyText;
    } else if (this._bodyType === "text/plain") {
      plainPart = new MimePart(
        this._bodyType,
        this._compFields.forceMsgEncoding,
        true
      );
      plainPart.setHeader(
        "content-type",
        `text/plain; charset=UTF-8${formatParam}`
      );
      plainPart.bodyText = this._bodyText;
      parts.plainPart = plainPart;
    }

    // Assemble a multipart/alternative message.
    if (
      (this._compFields.forcePlainText ||
        this._compFields.useMultipartAlternative) &&
      plainPart === null &&
      htmlPart !== null
    ) {
      plainPart = new MimePart(
        "text/plain",
        this._compFields.forceMsgEncoding,
        true
      );
      plainPart.setHeader(
        "content-type",
        `text/plain; charset=UTF-8${formatParam}`
      );
      // nsIParserUtils.convertToPlainText expects unicode string.
      const plainUnicode = MsgUtils.convertToPlainText(
        new TextDecoder().decode(
          jsmime.mimeutils.stringToTypedArray(this._bodyText)
        ),
        formatFlowed
      );
      // MimePart.bodyText should be binary string.
      plainPart.bodyText = jsmime.mimeutils.typedArrayToString(
        new TextEncoder().encode(plainUnicode)
      );

      parts.plainPart = plainPart;
    }

    // If useMultipartAlternative is true, send multipart/alternative message.
    // Otherwise, send the plainPart only.
    if (htmlPart) {
      if (
        (plainPart && this._compFields.useMultipartAlternative) ||
        !plainPart
      ) {
        parts.htmlPart = htmlPart;
      }
    }

    return parts;
  }

  /**
   * Collect local attachments.
   *
   * @returns {MimePart[]}
   */
  _gatherAttachmentParts() {
    const attachments = [...this._compFields.attachments];
    const cloudParts = [];
    const localParts = [];

    for (const attachment of attachments) {
      let part;
      if (attachment.htmlAnnotation) {
        part = new MimePart();
        // MimePart.bodyText should be binary string.
        part.bodyText = jsmime.mimeutils.typedArrayToString(
          new TextEncoder().encode(attachment.htmlAnnotation)
        );
        part.setHeader("content-type", "text/html; charset=utf-8");

        const suffix = /\.html$/i.test(attachment.name) ? "" : ".html";
        const encodedFilename = MsgUtils.rfc2231ParamFolding(
          "filename",
          `${attachment.name}${suffix}`
        );
        part.setHeader("content-disposition", `attachment; ${encodedFilename}`);
      } else {
        part = new MimePart(null, this._compFields.forceMsgEncoding, false);
        part.setBodyAttachment(attachment);
      }

      const cloudPartHeader = MsgUtils.getXMozillaCloudPart(
        this._deliverMode,
        attachment
      );
      if (cloudPartHeader) {
        part.setHeader("x-mozilla-cloud-part", cloudPartHeader);
      }

      localParts.push(part);
    }
    // Cloud attachments are handled before local attachments in the C++
    // implementation. We follow it here so that no need to change tests.
    return cloudParts.concat(localParts);
  }

  /**
   * Collect embedded objects as attachments.
   *
   * @returns {MimePart[]}
   */
  _gatherEmbeddedParts() {
    return this._embeddedAttachments.map(attachment => {
      const part = new MimePart(null, this._compFields.forceMsgEncoding, false);
      part.setBodyAttachment(attachment, "inline", attachment.contentId);
      return part;
    });
  }

  /**
   * If crypto encapsulation is required, returns an nsIMsgComposeSecure instance.
   *
   * @returns {?nsIMsgComposeSecure}
   */
  _getComposeSecure() {
    const secureCompose = this._compFields.composeSecure;
    if (!secureCompose) {
      return null;
    }

    if (
      this._deliverMode == Ci.nsIMsgSend.nsMsgSaveAsDraft &&
      !this._userIdentity.getBoolAttribute("autoEncryptDrafts")
    ) {
      return null;
    }

    if (
      !secureCompose.requiresCryptoEncapsulation(
        this._userIdentity,
        this._compFields
      )
    ) {
      return null;
    }
    return secureCompose;
  }

  /**
   * Pass a stream and other params to this._composeSecure to start crypto
   * encapsulation.
   */
  _startCryptoEncapsulation() {
    const recipients = [
      this._compFields.to,
      this._compFields.cc,
      this._compFields.bcc,
      this._compFields.newsgroups,
    ]
      .filter(Boolean)
      .join(",");

    this._composeSecure.beginCryptoEncapsulation(
      this._fstream,
      recipients,
      this._compFields,
      this._userIdentity,
      this._sendReport,
      this._deliverMode == Ci.nsIMsgSend.nsMsgSaveAsDraft
    );
    this._cryptoEncapsulationStarted = true;
  }

  /**
   * Recursively write an MimePart and its parts to a this._fstream.
   *
   * @param {MimePart} curPart - The MimePart to write out.
   * @param {number} [depth=0] - Nested level of a part.
   */
  async _writePart(curPart, depth = 0) {
    let bodyString;
    try {
      // `getEncodedBodyString()` returns a binary string.
      bodyString = await curPart.getEncodedBodyString();
    } catch (e) {
      if (e.data && /^data:/i.test(e.data.url)) {
        // Invalid data uri should not prevent sending message.
        return;
      }
      throw e;
    }

    if (depth == 0 && this._composeSecure) {
      // Crypto encapsulation will add a new content-type header.
      curPart.deleteHeader("content-type");
      if (curPart.parts.length > 1) {
        // Move child parts one layer deeper so that the message is still well
        // formed after crypto encapsulation.
        const newChild = new MimeMultiPart(curPart.subtype);
        newChild.parts = curPart._parts;
        curPart.parts = [newChild];
      }
    }

    // Write out headers, there could be non-ASCII in the headers
    // which we need to encode into UTF-8.
    this._writeString(curPart.getHeaderString());

    // Start crypto encapsulation if needed.
    if (depth == 0 && this._composeSecure) {
      this._startCryptoEncapsulation();
    }

    // Recursively write out parts.
    if (curPart.parts.length) {
      // single part message
      if (curPart.parts.length === 1) {
        await this._writePart(curPart.parts[0], depth + 1);
        this._writeBinaryString(bodyString);
        return;
      }

      // We can safely use `_writeBinaryString()` for ASCII strings.
      this._writeBinaryString("\r\n");
      if (depth == 0) {
        // Current part is a top part and multipart container.
        this._writeBinaryString(
          "This is a multi-part message in MIME format.\r\n"
        );
      }

      // multipart message
      for (const part of curPart.parts) {
        this._writeBinaryString(`--${curPart.separator}\r\n`);
        await this._writePart(part, depth + 1);
      }
      this._writeBinaryString(`\r\n--${curPart.separator}--\r\n`);
      if (depth > 1) {
        // If more separators follow, make sure there is a blank line after
        // this one.
        this._writeBinaryString("\r\n");
      }
    } else {
      this._writeBinaryString(`\r\n`);
    }

    // Ensure there is exactly one blank line after a part and before
    // the boundary, and exactly one blank line between boundary lines.
    // This works around bugs in other software that erroneously remove
    // additional blank lines, thereby causing verification failures of
    // OpenPGP or S/MIME signatures. For example see bug 1731529.

    // Write out body.
    this._writeBinaryString(bodyString);
  }

  /**
   * Write a binary string to this._fstream.
   *
   * @param {BinaryString} str - The binary string to write.
   */
  _writeBinaryString(str) {
    this._cryptoEncapsulationStarted
      ? this._composeSecure.mimeCryptoWriteBlock(str, str.length)
      : this._fstream.write(str, str.length);
  }

  /**
   * Write a string to this._fstream.
   *
   * @param {string} str - The string to write.
   */
  _writeString(str) {
    this._writeBinaryString(
      jsmime.mimeutils.typedArrayToString(new TextEncoder().encode(str))
    );
  }
}
