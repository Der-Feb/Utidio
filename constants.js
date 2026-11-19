globalThis.TAB_AUDIO_SENTINEL = globalThis.TAB_AUDIO_SENTINEL || Object.freeze({
  actions: Object.freeze({
    GET_STATUS: 'GET_STATUS',
    SET_ENABLED: 'SET_ENABLED',
    MEDIA_UPDATE: 'MEDIA_UPDATE',
    GET_MEDIA_STATUS: 'GET_MEDIA_STATUS',
    PAUSE: 'PAUSE',
    RESUME: 'RESUME',
    TOGGLE_TAB: 'TOGGLE_TAB',
    FOCUS_TAB: 'FOCUS_TAB',
  }),
  storageKeys: Object.freeze({
    ENABLED: 'enabled',
    MEDIA_TABS: 'mediaTabs',
  }),
});
