function getSelector(el) {
  if (!el || el.nodeType !== 1) return '';
  const parts = [];
  while (el && el.nodeType === 1) {
    let part = el.tagName.toLowerCase();
    if (el.id) {
      part += `#${el.id}`;
      parts.unshift(part);
      break;
    } else {
      if (el.className) {
        part += '.' + el.className.trim().split(/\s+/).join('.');
      }
      const siblings = Array.from(el.parentNode ? el.parentNode.children : []).filter(e => e.tagName === el.tagName);
      if (siblings.length > 1) {
        const index = siblings.indexOf(el) + 1;
        part += `:nth-of-type(${index})`;
      }
    }
    parts.unshift(part);
    el = el.parentNode;
  }
  return parts.join(' > ');
}

function extractDetails(el) {
  return {
    tag: el.tagName,
    text: el.innerText?.trim() || '',
    id: el.id || '',
    name: el.name || '',
    className: el.className || '',
    type: el.type || '',
    value: el.value || '',
    checked: el.checked ?? undefined,
    selector: getSelector(el)
  };
}

function registerListeners(recordFnName = 'recordEvent') {
  window._lastAction = { type: null, el: null, time: 0 };

  document.addEventListener('click', e => {
    const now = Date.now();
    window._lastAction = { type: 'click', el: e.target, time: now };
    const detail = extractDetails(e.target);
    window[recordFnName]({
      type: 'click',
      detail,
      timestamp: now
    });
  }, true);

  document.addEventListener('input', e => {
    const now = Date.now();
    if (
      window._lastAction.type === 'click' &&
      (window._lastAction.el === e.target || window._lastAction.el.contains(e.target)) &&
      now - window._lastAction.time < 300
    ) {
      console.log('⚠️ Skipped input caused by click');
      return;
    }
    const detail = extractDetails(e.target);
    window[recordFnName]({
      type: 'input',
      detail,
      timestamp: now
    });
  }, true);
}

function setupRecorder(recordFnName = 'recordEvent') {
  window.getSelector = getSelector;
  window.extractDetails = extractDetails;
  registerListeners(recordFnName);
}

module.exports = { getSelector, extractDetails, registerListeners, setupRecorder };
