// x.com 手机网页：去掉「Get the full app experience / Open X」弹窗，并恢复页面滚动。
// 弹窗在 #layers 下面的某一层里，整层藏掉（连灰色遮罩一起）。
// 不删节点，只 display:none，React 以后复用这一层显示别的对话框（比如登录）时会自动放出来。
CLEANERS.x = {
  match: /(^|\.)(x|twitter)\.com$/,
  run: function () {
    var FULL_APP = /full app experience|完整的?\s*(应用|App)\s*体验|完整的?應用程式體驗/i;
    var OPEN_APP = /\bOpen X\b|打开\s*X|開啟\s*X|在\s*X\s*(应用|App)\s*中打开/i;
    var hidden = typeof WeakSet === 'function' ? new WeakSet() : null;
    var active = false;
    var scheduled = false;

    function isNag(layer) {
      var dialog = layer.querySelector('[role="dialog"], [aria-modal="true"]');
      if (!dialog) return false;
      var text = dialog.textContent || '';
      if (FULL_APP.test(text)) return true;
      // 只有「打开 App」按钮、没有输入框的对话框才算，避免误伤登录框
      return OPEN_APP.test(text) && !dialog.querySelector('input, textarea');
    }

    var forced = false;

    // 弹窗藏着的时候强制能滚动；弹窗没了就把我们加的样式撤掉，交还给 X
    function unlockScroll() {
      // 只在值不对时才写，否则写样式会再触发下面的 attributes 监听，形成死循环
      [document.documentElement, document.body].forEach(function (el) {
        if (!el) return;
        if (el.style.getPropertyValue('overflow') !== 'auto' || el.style.getPropertyPriority('overflow') !== 'important') {
          el.style.setProperty('overflow', 'auto', 'important');
        }
      });
      forced = true;
    }

    function releaseScroll() {
      if (!forced) return;
      [document.documentElement, document.body].forEach(function (el) {
        if (el) el.style.removeProperty('overflow');
      });
      forced = false;
    }

    function run() {
      scheduled = false;
      var layers = document.getElementById('layers');
      if (!layers || !hidden) return;
      active = false;
      for (var i = 0; i < layers.children.length; i++) {
        var layer = layers.children[i];
        if (isNag(layer)) {
          if (!hidden.has(layer)) {
            layer.style.setProperty('display', 'none', 'important');
            hidden.add(layer);
          }
          active = true;
        } else if (hidden.has(layer)) {
          layer.style.removeProperty('display');
          hidden.delete(layer);
        }
      }
      if (active) unlockScroll();
      else releaseScroll();
    }

    function schedule() {
      if (scheduled) return;
      scheduled = true;
      (window.requestAnimationFrame || setTimeout)(run);
    }

    new MutationObserver(schedule).observe(document, { childList: true, subtree: true });
    // 弹窗出来时 X 会在 <html> 上锁滚动，锁的时机可能晚于弹窗本身
    new MutationObserver(function () { if (active) unlockScroll(); })
      .observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] });
    schedule();
  },
};
