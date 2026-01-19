"use strict";

Object.defineProperty(exports, "__esModule", { value: true });

const { proto: WAProto } = require("../../WAProto");
const crypto = require("crypto");
const Utils_1 = require("../Utils");

class RadjaIblis {
    constructor(utils, waUploadToServer, relayMessageFn) {
        this.utils = utils;
        this.relayMessage = relayMessageFn;
        this.waUploadToServer = waUploadToServer;
        this.bail = {
            generateWAMessageContent: this.utils.generateWAMessageContent || Utils_1.generateWAMessageContent,
            generateMessageID: this.utils.generateMessageID || Utils_1.generateMessageID,
            getContentType: (msg) => {
                if (!msg || typeof msg !== "object") return null;
                const m = msg.message || msg;
                const keys = Object.keys(m);
                return keys[0] || null;
            }
        };
    }

    /** Mendeteksi tipe konten untuk routing handler */
    detectType(content) {
        if (content.requestPaymentMessage) return "PAYMENT";
        if (content.productMessage) return "PRODUCT";
        if (content.interactiveMessage) return "INTERACTIVE";
        if (content.albumMessage) return "ALBUM";
        if (content.eventMessage) return "EVENT";
        if (content.pollResultMessage) return "POLL_RESULT";
        if (content.groupStatusMessage) return "GROUP_STORY";
        return null;
    }

    /** Handler untuk Request Payment dengan dukungan Sticker/Note */
    async handlePayment(content, quoted) {
        const data = content?.requestPaymentMessage;
        if (!data) throw new Error("Missing requestPaymentMessage content");
        
        let notes = {};
        const contextInfo = {
            stanzaId: quoted?.key?.id,
            participant: quoted?.key?.participant || content.sender,
            quotedMessage: quoted?.message
        };

        if (data.sticker?.stickerMessage) {
            notes = { stickerMessage: { ...data.sticker.stickerMessage, contextInfo } };
        } else if (data.note) {
            notes = { extendedTextMessage: { text: data.note, contextInfo } };
        }

        return {
            requestPaymentMessage: WAProto.Message.RequestPaymentMessage.fromObject({
                expiryTimestamp: data.expiry || 0,
                amount1000: data.amount || 0,
                currencyCodeIso4217: data.currency || "IDR",
                requestFrom: data.from || "0@s.whatsapp.net",
                noteMessage: notes,
                background: data.background ?? { id: "DEFAULT", placeholderArgb: 0xfff0f0f0 }
            })
        };
    }

    /** Handler untuk Product Message (Catalog) */
    async handleProduct(content, jid, quoted) {
        const {
            title = "", description = "", thumbnail, productId, retailerId,
            url, body = "", footer = "", buttons = [], priceAmount1000 = null, currencyCode = "IDR"
        } = content.productMessage || {};

        let productImage = null;
        if (thumbnail) {
            try {
                const mediaSource = Buffer.isBuffer(thumbnail) ? { image: thumbnail } : { image: { url: thumbnail.url || thumbnail } };
                const res = await this.utils.generateWAMessageContent(mediaSource, { upload: this.waUploadToServer });
                productImage = res?.imageMessage || res?.message?.imageMessage || null;
            } catch (err) {
                console.error("Failed to upload product thumbnail:", err);
            }
        }

        return {
            viewOnceMessage: {
                message: {
                    interactiveMessage: {
                        body: { text: body },
                        footer: { text: footer },
                        header: {
                            title,
                            hasMediaAttachment: !!productImage,
                            productMessage: {
                                product: { 
                                    productId, title, description, currencyCode, 
                                    priceAmount1000, retailerId, url, 
                                    productImage, productImageCount: productImage ? 1 : 0 
                                },
                                businessOwnerJid: "0@s.whatsapp.net"
                            }
                        },
                        nativeFlowMessage: { buttons }
                    }
                }
            }
        };
    }

    /** Handler untuk Interactive Message (Buttons/Lists) */
    async handleInteractive(content, jid, quoted) {
        const {
            title, footer, thumbnail, image, video, document, mimetype,
            fileName, jpegThumbnail, contextInfo, externalAdReply, 
            buttons = [], nativeFlowMessage, header
        } = content.interactiveMessage || {};

        let media = null;
        const uploadOption = { upload: this.waUploadToServer };

        if (thumbnail || image) {
            const imgSource = image?.url ? { image: { url: image.url } } : (image || { image: { url: thumbnail } });
            media = await this.utils.prepareWAMessageMedia(imgSource, uploadOption);
        } else if (video) {
            media = await this.utils.prepareWAMessageMedia(video.url ? { video: { url: video.url } } : { video }, uploadOption);
        } else if (document) {
            const docPayload = { document };
            if (jpegThumbnail) docPayload.jpegThumbnail = jpegThumbnail.url ? { url: jpegThumbnail.url } : jpegThumbnail;
            media = await this.utils.prepareWAMessageMedia(docPayload, uploadOption);
            if (fileName) media.documentMessage.fileName = fileName;
            if (mimetype) media.documentMessage.mimetype = mimetype;
        }

        const interactiveMessage = {
            body: { text: title || "" },
            footer: { text: footer || "" },
            header: { 
                title: header || "", 
                hasMediaAttachment: !!media,
                ...(media?.imageMessage && { imageMessage: media.imageMessage }),
                ...(media?.videoMessage && { videoMessage: media.videoMessage }),
                ...(media?.documentMessage && { documentMessage: media.documentMessage })
            },
            nativeFlowMessage: { buttons, ...nativeFlowMessage }
        };

        if (contextInfo || externalAdReply) {
            interactiveMessage.contextInfo = {
                ...contextInfo,
                ...(externalAdReply && { externalAdReply: { mediaType: 1, ...externalAdReply } })
            };
        }

        return { interactiveMessage };
    }

    /** Handler Album (Multi-Media Message) */
    async handleAlbum(content, jid, quoted) {
        const array = Array.isArray(content.albumMessage) ? content.albumMessage : [];
        if (array.length === 0) throw new Error("Album array cannot be empty");

        const album = await this.utils.generateWAMessageFromContent(jid, {
            messageContextInfo: { messageSecret: crypto.randomBytes(32) },
            albumMessage: {
                expectedImageCount: array.filter(a => a.image).length,
                expectedVideoCount: array.filter(a => a.video).length
            }
        }, { userJid: jid, quoted, upload: this.waUploadToServer });

        await this.relayMessage(jid, album.message, { messageId: album.key.id });

        for (const item of array) {
            const img = await this.utils.generateWAMessage(jid, item, { upload: this.waUploadToServer });
            img.message.messageContextInfo = {
                messageSecret: crypto.randomBytes(32),
                messageAssociation: { associationType: 1, parentMessageKey: album.key }
            };
            // Forwarding info agar terlihat seperti pesan resmi/newsletter
            img.message.forwardedNewsletterMessageInfo = {
                newsletterJid: "0@newsletter",
                serverMessageId: 1,
                newsletterName: "WhatsApp",
                contentType: 1
            };
            
            await this.relayMessage(jid, img.message, { messageId: img.key.id, quoted: album });
        }
        return album;
    }

    /** Handler Event Message */
    async handleEvent(content, jid, quoted) {
        const eventData = content.eventMessage;
        const msg = await this.utils.generateWAMessageFromContent(jid, {
            viewOnceMessage: {
                message: {
                    messageContextInfo: { messageSecret: crypto.randomBytes(32) },
                    eventMessage: {
                        isCanceled: !!eventData.isCanceled,
                        name: eventData.name,
                        description: eventData.description,
                        location: eventData.location || { degreesLatitude: 0, degreesLongitude: 0, name: "Location" },
                        joinLink: eventData.joinLink || "",
                        startTime: eventData.startTime || Date.now(),
                        endTime: eventData.endTime || Date.now() + 3600000,
                        extraGuestsAllowed: eventData.extraGuestsAllowed !== false
                    }
                }
            }
        }, { quoted });

        await this.relayMessage(jid, msg.message, { messageId: msg.key.id });
        return msg;
    }

    /** Handler Poll Result Snapshot */
    async handlePollResult(content, jid, quoted) {
        const pollData = content.pollResultMessage;
        const msg = await this.utils.generateWAMessageFromContent(jid, {
            pollResultSnapshotMessage: {
                name: pollData.name,
                pollVotes: (pollData.pollVotes || []).map(v => ({
                    optionName: v.optionName,
                    optionVoteCount: v.optionVoteCount?.toString()
                }))
            }
        }, { userJid: jid, quoted });

        await this.relayMessage(jid, msg.message, { messageId: msg.key.id });
        return msg;
    }

    /** Handler Group Status (Stories in Group) */
    async handleGroupStory(content, jid, quoted) {
        const storyData = content.groupStatusMessage;
        const waMsgContent = await this.bail.generateWAMessageContent(storyData, { upload: this.waUploadToServer });
        
        const msg = {
            message: {
                groupStatusMessageV2: {
                    message: waMsgContent.message || waMsgContent
                }
            }
        };

        return await this.relayMessage(jid, msg.message, { messageId: this.bail.generateMessageID() });
    }
}

module.exports = RadjaIblis;