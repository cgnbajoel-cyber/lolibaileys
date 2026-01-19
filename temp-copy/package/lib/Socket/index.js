"use strict"

Object.defineProperty(exports, "__esModule", { value: true })

const { DEFAULT_CONNECTION_CONFIG } = require("../Defaults");
const communities_1 = require("./communities"); 
global.__SOCKET_MAP__ = global.__SOCKET_MAP__ || new Map()

/**
 * * @param {Object} config - Konfigurasi Baileys
 * @param {String} sessionId - ID Unik
 */
const makeWASocket = (config, sessionId = 'primary') => {
  if (global.__SOCKET_MAP__.has(sessionId)) {
    const oldSock = global.__SOCKET_MAP__.get(sessionId)
    
    try {
      oldSock.ws?.close?.()
      oldSock.ws?.terminate?.()
      oldSock.ws?.removeAllListeners?.()
      oldSock.ev?.removeAllListeners?.()
    } catch (e) {
    }
    global.__SOCKET_MAP__.delete(sessionId)
  }
  // -----------------------------------

  const sock = (0, communities_1.makeCommunitiesSocket)({
        ...DEFAULT_CONNECTION_CONFIG,
        ...config
    });

  global.__SOCKET_MAP__.set(sessionId, sock)
  sock.ws.on('close', () => {
      if (global.__SOCKET_MAP__.get(sessionId) === sock) {
          global.__SOCKET_MAP__.delete(sessionId)
      }
  })

  return sock
}

exports.default = makeWASocket
