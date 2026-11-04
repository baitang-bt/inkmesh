(function (global) {
  'use strict';

  const DEFAULT_ICE = [{ urls: 'stun:stun.l.google.com:19302' }];

  /**
   * 创建一对 WebRTC 连接与可靠有序数据通道。
   * @param {object} options
   * @param {boolean} options.createDataChannel 是否由本端创建通道（offer 方）
   * @param {function} options.onMessage 收到 JSON 对象
   * @param {function} options.onOpen 通道打开
   * @param {function} options.onClose 通道关闭
   * @param {function} options.onIce ICE 候选
   */
  function createPeerLink(options) {
    const settings = options || {};
    const pc = new RTCPeerConnection({
      iceServers: settings.iceServers || DEFAULT_ICE
    });
    let dc = null;
    let closed = false;
    const state = {
      pc,
      _pendingIce: [],
      get dc() {
        return dc;
      },
      remotePeerId: settings.remotePeerId || ''
    };

    /** 只触发一次关闭回调，避免 dc/pc 重复通知。 */
    function emitClose() {
      if (closed) return;
      closed = true;
      if (settings.onClose) settings.onClose(state);
    }

    /** 绑定数据通道收发。 */
    function wireChannel(channel) {
      dc = channel;
      dc.binaryType = 'arraybuffer';
      dc.addEventListener('open', () => {
        if (settings.onOpen) settings.onOpen(state);
      });
      dc.addEventListener('close', () => {
        emitClose();
      });
      dc.addEventListener('error', () => {
        emitClose();
      });
      dc.addEventListener('message', event => {
        let data;
        try {
          data = JSON.parse(event.data);
        } catch (_err) {
          return;
        }
        if (settings.onMessage) settings.onMessage(data, state);
      });
    }

    pc.addEventListener('icecandidate', event => {
      if (!event.candidate) return;
      if (settings.onIce) settings.onIce(event.candidate.toJSON(), state);
    });

    pc.addEventListener('connectionstatechange', () => {
      const cs = pc.connectionState;
      // disconnected 可能是短暂 ICE 抖动，不拆连接；failed/closed 才收工。
      if (cs === 'failed' || cs === 'closed') {
        emitClose();
      }
    });

    if (settings.createDataChannel) {
      wireChannel(
        pc.createDataChannel('inkmesh', {
          ordered: true
        })
      );
    } else {
      pc.addEventListener('datachannel', event => {
        wireChannel(event.channel);
      });
    }

    return state;
  }

  /** 冲刷在 setRemoteDescription 之前到达的 ICE 候选。 */
  async function flushPendingIce(link) {
    if (!link || !link.pc) return;
    const pending = link._pendingIce || [];
    link._pendingIce = [];
    for (let i = 0; i < pending.length; i += 1) {
      try {
        await link.pc.addIceCandidate(pending[i]);
      } catch (_err) {}
    }
  }

  /** 经数据通道发送 JSON；通道未开时返回 false。 */
  function sendOnLink(link, payload) {
    if (!link || !link.dc || link.dc.readyState !== 'open') return false;
    link.dc.send(JSON.stringify(payload));
    return true;
  }

  /** 关闭连接与通道。 */
  function closeLink(link) {
    if (!link) return;
    try {
      if (link.dc) link.dc.close();
    } catch (_err) {}
    try {
      if (link.pc) link.pc.close();
    } catch (_err) {}
  }

  /** 本端作为 offer 方创建描述。 */
  async function createOfferSdp(link) {
    const offer = await link.pc.createOffer();
    await link.pc.setLocalDescription(offer);
    return link.pc.localDescription;
  }

  /** 收到 offer 后创建 answer。 */
  async function acceptOfferCreateAnswer(link, sdp) {
    await link.pc.setRemoteDescription(sdp);
    await flushPendingIce(link);
    const answer = await link.pc.createAnswer();
    await link.pc.setLocalDescription(answer);
    return link.pc.localDescription;
  }

  /** 房客收到 answer。 */
  async function applyAnswer(link, sdp) {
    await link.pc.setRemoteDescription(sdp);
    await flushPendingIce(link);
  }

  /**
   * 追加远端 ICE；远端描述未就绪时先入队，避免 trickle 竞态丢候选。
   */
  async function addIceCandidate(link, candidate) {
    if (!link || !candidate) return;
    if (!link.pc.remoteDescription) {
      if (!link._pendingIce) link._pendingIce = [];
      link._pendingIce.push(candidate);
      return;
    }
    try {
      await link.pc.addIceCandidate(candidate);
    } catch (_err) {}
  }

  global.P2pTransport = {
    createPeerLink,
    sendOnLink,
    closeLink,
    createOfferSdp,
    acceptOfferCreateAnswer,
    applyAnswer,
    addIceCandidate,
    flushPendingIce,
    DEFAULT_ICE
  };
})(window);
