const app = getApp();

Page({
  data: {
    stage: 'loading',
    url: '',
    errMsg: '网页加载失败',
  },

  onLoad(query) {
    // 支持通过 ?space=xxx&room=yyy 透传场景参数
    const base = app.globalData.h5Url;
    const qs = Object.keys(query || {})
      .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(query[k])}`)
      .join('&');
    const url = qs ? `${base}${base.includes('?') ? '&' : '?'}${qs}` : base;
    this.setData({ url, stage: 'loading' });
    // 给原生骨架留一小段可视时间，避免白屏跳动
    setTimeout(() => this.setData({ stage: 'web' }), 260);
  },

  onWebLoad() {
    // web-view 已加载完成，隐藏原生骨架（web-view 本身仍覆盖全屏）
    this.setData({ stage: 'web' });
  },

  onMessage(e) {
    const list = (e.detail && e.detail.data) || [];
    const last = list[list.length - 1];
    if (last && last.type === 'share') {
      wx.setClipboardData({ data: last.url || app.globalData.h5Url });
    }
  },

  onWebError() {
    this.setData({ stage: 'error', errMsg: '网页加载失败，请检查业务域名与证书' });
  },

  retry() {
    const url = this.data.url;
    this.setData({ stage: 'web', url: '' }, () => this.setData({ url }));
  },

  copyLink() {
    wx.setClipboardData({ data: this.data.url });
  },

  onShareAppMessage() {
    return { title: '四维空间 · 东山岛悦华酒店', path: '/pages/index/index' };
  },
});
