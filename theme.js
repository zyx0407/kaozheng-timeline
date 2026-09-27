/* 配色（沿用 IP 站 C-gallery 的 theme.js，行为一字不改）
   ① 首帧前定好主题，避免闪一下
   ② 顶栏那枚圆钮的手动切换（他定的：直接换、不做过渡）
   ③ 没手动选过就跟随系统
   ?theme=day|night 可强制指定（只给测试 / 出图用，不写入本地） */
(function () {
  var root = document.documentElement;
  var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  var forced = /[?&]theme=(day|night)/.exec(location.search);
  var saved = null;
  try { saved = localStorage.getItem('zyx-theme'); } catch (e) {}

  function systemTheme() { return mq && mq.matches ? 'night' : 'day'; }
  function current() { return root.getAttribute('data-theme') === 'night' ? 'night' : 'day'; }

  function paint(t) {
    if (t === 'night') root.setAttribute('data-theme', 'night');
    else root.removeAttribute('data-theme');
    var btn = document.getElementById('themeBtn');
    if (btn) {
      var next = (t === 'night') ? '白天' : '深夜';
      btn.setAttribute('aria-label', '切换到' + next);
      btn.setAttribute('title', '切换到' + next);
    }
  }

  // ① 首帧前先定下来
  paint((forced && forced[1]) || saved || systemTheme());

  document.addEventListener('DOMContentLoaded', function () {
    // ② 手动切换
    var btn = document.getElementById('themeBtn');
    if (btn) {
      btn.addEventListener('click', function () {
        var t = (current() === 'night') ? 'day' : 'night';
        try { localStorage.setItem('zyx-theme', t); } catch (e) {}
        paint(t);
      });
    }
    // ③ 没手动选过才跟系统
    if (!forced && !saved && mq) {
      var onChange = function () { paint(systemTheme()); };
      if (mq.addEventListener) mq.addEventListener('change', onChange);
      else if (mq.addListener) mq.addListener(onChange);
    }
  });
})();
