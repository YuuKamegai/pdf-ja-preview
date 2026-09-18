// @ts-check
(function () {
  const vscode = acquireVsCodeApi();
  const banner = document.getElementById('banner');
  const notice = document.getElementById('notice');
  const container = document.getElementById('blocks');

  /** 拡張が起こしたスクロールの跳ね返りを拡張へ返さないための抑制。 */
  let suppressScrollUntil = 0;

  function renderBlock(view) {
    let element = document.querySelector(`[data-index="${view.index}"]`);
    if (!element) {
      element = document.createElement('section');
      element.dataset.index = String(view.index);
      container.appendChild(element);
    }
    element.className = `block state-${view.state}`;
    element.dataset.lineStart = String(view.lineStart ?? element.dataset.lineStart ?? 0);
    element.innerHTML = view.html;

    if (view.state === 'error') {
      const button = document.createElement('button');
      button.className = 'retry';
      button.textContent = '再試行';
      button.addEventListener('click', () =>
        vscode.postMessage({ kind: 'retry', index: view.index }),
      );
      element.appendChild(button);
    }
  }

  window.addEventListener('message', (event) => {
    const message = event.data;

    if (message.kind === 'init') {
      container.textContent = '';
      for (const view of message.blocks) renderBlock(view);
      return;
    }

    if (message.kind === 'block') {
      const existing = document.querySelector(`[data-index="${message.index}"]`);
      renderBlock({
        index: message.index,
        html: message.html,
        state: message.state,
        lineStart: existing ? Number(existing.dataset.lineStart) : 0,
      });
      return;
    }

    if (message.kind === 'banner') {
      banner.textContent = message.text;
      banner.hidden = message.text === '';
      return;
    }

    if (message.kind === 'notice') {
      notice.textContent = message.text;
      notice.hidden = message.text === '';
      return;
    }

    if (message.kind === 'scrollTo') {
      const target = document.querySelector(`[data-index="${message.index}"]`);
      if (!target) return;
      suppressScrollUntil = Date.now() + 250;
      const offset = target.offsetTop + target.offsetHeight * (message.ratio || 0);
      window.scrollTo({ top: offset - 24, behavior: 'auto' });
    }
  });

  window.addEventListener(
    'scroll',
    () => {
      if (Date.now() < suppressScrollUntil) return;
      const blocks = container.children;
      for (let i = 0; i < blocks.length; i++) {
        const element = blocks[i];
        if (element.offsetTop + element.offsetHeight <= window.scrollY) continue;
        const ratio = (window.scrollY - element.offsetTop) / (element.offsetHeight || 1);
        vscode.postMessage({
          kind: 'scrolled',
          index: Number(element.dataset.index),
          ratio: Math.min(Math.max(ratio, 0), 1),
        });
        return;
      }
    },
    { passive: true },
  );

  vscode.postMessage({ kind: 'ready' });
})();
