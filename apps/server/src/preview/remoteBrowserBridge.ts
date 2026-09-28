/** Installed in each frame; it does work only on input or a watched target's style changes. */
export const remoteBrowserBridge = `(() => {
  if (globalThis.__pathwayBrowserBridge) return;
  globalThis.__pathwayBrowserBridge = true;
  void globalThis.__pathwayBrowserEvent({ type: 'ready' }).then(watched => { globalThis.__pathwayBrowserWatching = watched; }).catch(() => {});
  const emit = value => { void globalThis.__pathwayBrowserEvent(value).catch(() => {}); };
  let cursor = 'default', target = null, scheduled = false;
  const update = () => {
    scheduled = false;
    if (!globalThis.__pathwayBrowserWatching || !target || !target.isConnected) return;
    let next = getComputedStyle(target).cursor;
    if (next === 'auto') next = target.closest('a[href]') ? 'pointer' : target.closest('textarea,input:not([type]),input[type=text],input[type=password],input[type=email],input[type=search],input[type=url],input[type=tel],[contenteditable="true"]') ? 'text' : 'default';
    if (next.includes('url(')) next = next.split(',').at(-1).trim();
    if (next !== cursor) { cursor = next; emit({ type: 'cursor', cursor }); }
  };
  const schedule = () => { if (!globalThis.__pathwayBrowserWatching) return; if (!scheduled) { scheduled = true; requestAnimationFrame(update); } };
  const observer = new MutationObserver(schedule);
  document.addEventListener('pointermove', event => {
    if (!globalThis.__pathwayBrowserWatching) return;
    const next = event.composedPath().find(node => node instanceof Element);
    if (next && next !== target) { target = next; observer.disconnect(); observer.observe(target, { attributes: true, attributeFilter: ['style', 'class'] }); }
    schedule();
  }, true);
  const selectedText = () => {
    const el = document.activeElement;
    if (el && typeof el.selectionStart === 'number') return el.value.slice(el.selectionStart, el.selectionEnd);
    return String(getSelection() || '');
  };
  for (const type of ['copy', 'cut']) document.addEventListener(type, event => {
    if (!globalThis.__pathwayBrowserWatching) return;
    const fallback = selectedText();
    setTimeout(() => emit({ type: 'clipboard', text: (event.clipboardData?.getData('text/plain') || fallback).slice(0, 64000) }), 0);
  }, true);
  const openSelect = event => {
    if (!globalThis.__pathwayBrowserWatching) return;
    const element = event.composedPath().find(node => node instanceof HTMLSelectElement);
    if (!element || element.disabled || element.size > 1) return;
    if (event.type === 'keydown' && ![' ', 'Enter', 'ArrowDown', 'ArrowUp'].includes(event.key)) return;
    event.preventDefault();
    element.focus();
    if (event.type === 'click' && globalThis.__pathwayRemoteSelect?.element === element) return;
    const id = crypto.randomUUID();
    globalThis.__pathwayRemoteSelect = { id, element };
    emit({ type: 'select', selectId: id, multiple: element.multiple, options: Array.from(element.options).slice(0, 1000).map((option, index) => ({ index, label: option.label.slice(0, 1000), value: option.value.slice(0, 1000), selected: option.selected, disabled: option.disabled || (option.parentElement instanceof HTMLOptGroupElement && option.parentElement.disabled) })) });
  };
  for (const type of ['pointerdown', 'click', 'keydown']) document.addEventListener(type, openSelect, true);
})()`;

export function selectResponseScript(selectId: string, indices: ReadonlyArray<number> | null) {
  return `(({ id, indices }) => {
    const pending = globalThis.__pathwayRemoteSelect;
    if (!pending || pending.id !== id || !pending.element.isConnected) throw new Error('The select popup is no longer open.');
    const element = pending.element;
    if (indices !== null) {
      if (!element.multiple && indices.length !== 1) throw new Error('Choose one option.');
      for (const index of indices) {
        const option = element.options[index];
        if (!option || option.disabled || (option.parentElement instanceof HTMLOptGroupElement && option.parentElement.disabled)) throw new Error('The option is unavailable.');
      }
      for (const option of element.options) option.selected = indices.includes(option.index);
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    }
    globalThis.__pathwayRemoteSelect = null;
  })(${JSON.stringify({ id: selectId, indices })})`;
}
