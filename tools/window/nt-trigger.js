/* 聊天框触发词 → 全屏彩蛋
   三个聊天页（ui2 / crt / index.html）在【消息真正发出后】调用
   window.ntMaybeTrigger(text)。只有完全等于 TRIGGERS 中任意一条才请求 /elymes-api/nt，
   请求失败静默忽略，不打断正常聊天。 */
(() => {
  'use strict';

  const TRIGGERS = [
    '316651',
    '都是你这个病毒来赖在电脑里不出来占用太高了害得吧',
  ];

  window.NT_TRIGGERS = TRIGGERS;
  window.NT_TRIGGER = TRIGGERS[0];

  window.ntMaybeTrigger = (text) => {
    try {
      const value = String(text == null ? '' : text).trim();
      if (!TRIGGERS.includes(value)) return false;
      fetch('/elymes-api/nt', { method: 'POST' }).catch(() => {});
      return true;
    } catch {
      return false;
    }
  };
})();
