App({
  globalData: {
    /**
     * H5 承载地址（必须 https，并在小程序后台配置「业务域名」）。
     * 开发阶段可在微信开发者工具「详情 → 本地设置」勾选「不校验合法域名」。
     */
    h5Url: 'https://your-domain.com/four-dimension/',
  },
  onLaunch() {
    wx.setKeepScreenOn({ keepScreenOn: true });
  },
});
