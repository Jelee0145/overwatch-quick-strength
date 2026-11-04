// Just enough DOM for events.js: text nodes, reflected attributes and in-place child patching.
const text = (value) => ({
  nodeType: 3,
  nodeValue: String(value),
  get textContent() {
    return this.nodeValue;
  },
  remove() {
    detach(this);
  }
});
const adopt = (parent, item) => {
  const node = typeof item === 'string' ? text(item) : item;
  detach(node);
  node.parentNode = parent;
  return node;
};
function detach(node) {
  const list = node.parentNode?.childNodes,
    at = list ? list.indexOf(node) : -1;
  if (at >= 0) list.splice(at, 1);
  node.parentNode = null;
}
const reflected = ['title', 'href', 'src', 'type', 'target', 'rel', 'dateTime', 'loading'];
export function element(tag = 'div') {
  const node = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    childNodes: [],
    attributes: {},
    value: '',
    hidden: false,
    events: {},
    dataset: {},
    className: '',
    classList: {
      add() {},
      contains: () => false
    },
    get children() {
      return this.childNodes.filter((n) => n.nodeType === 1);
    },
    get childElementCount() {
      return this.children.length;
    },
    get lastChild() {
      return this.childNodes.at(-1) || null;
    },
    get textContent() {
      return this.childNodes.map((n) => n.textContent).join('');
    },
    set textContent(value) {
      this.replaceChildren(...(String(value) ? [String(value)] : []));
    },
    get disabled() {
      return this.hasAttribute('disabled');
    },
    set disabled(value) {
      if (value) this.setAttribute('disabled', '');
      else this.removeAttribute('disabled');
    },
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    },
    getAttribute(name) {
      return this.hasAttribute(name) ? this.attributes[name] : null;
    },
    hasAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attributes, name);
    },
    removeAttribute(name) {
      delete this.attributes[name];
    },
    getAttributeNames() {
      return Object.keys(this.attributes);
    },
    append(...items) {
      for (const item of items) this.childNodes.push(adopt(this, item));
    },
    replaceChildren(...items) {
      for (const child of [...this.childNodes]) detach(child);
      this.append(...items);
    },
    replaceChild(next, old) {
      const at = this.childNodes.indexOf(old);
      detach(old);
      this.childNodes.splice(at, 0, adopt(this, next));
    },
    remove() {
      detach(this);
    },
    addEventListener(type, fn) {
      (this.events[type] ||= []).push(fn);
    }
  };
  for (const name of reflected)
    Object.defineProperty(node, name, {
      get: () => node.getAttribute(name) ?? '',
      set: (value) => node.setAttribute(name, value)
    });
  return node;
}
