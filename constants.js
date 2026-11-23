globalThis.TAB_AUDIO_SENTINEL = globalThis.TAB_AUDIO_SENTINEL || Object.freeze({
  actions: Object.freeze({
    GET_STATUS: 'GET_STATUS',
    SET_ENABLED: 'SET_ENABLED',
    PLAY_INTENT: 'PLAY_INTENT',
    MEDIA_UPDATE: 'MEDIA_UPDATE',
    SET_MEDIA_MUTED: 'SET_MEDIA_MUTED',
    TOGGLE_TAB: 'TOGGLE_TAB',
    FOCUS_TAB: 'FOCUS_TAB',
  }),
  storageKeys: Object.freeze({
    ENABLED: 'enabled',
    MEDIA_TABS: 'mediaTabs',
    DAILY_LISTENING: 'dailyListeningMs',
  }),
  listeningAlarm: 'listening-checkpoint',
});
