// A clone owns physical IDs, while controllers keep their existing logical IDs.
// The node map survives docking, which reparents individual Inspector units.
export function clonePanelScope(template, instanceId) {
  const root = template.cloneNode(true);
  const nodes = new Map();
  const domId = (id) => `panel-${instanceId}--${id}`;
  const elements = [root, ...root.querySelectorAll('*')];
  for (const element of elements) {
    if (!element.id) continue;
    const id = element.id;
    nodes.set(id, element);
    element.dataset.panelId = id;
    element.id = domId(id);
  }
  for (const element of elements) {
    for (const attribute of [
      'for',
      'form',
      'list',
      'aria-labelledby',
      'aria-describedby',
      'aria-controls',
      'aria-activedescendant',
      'aria-owns',
      'headers',
    ]) {
      if (!element.hasAttribute(attribute)) continue;
      element.setAttribute(
        attribute,
        element
          .getAttribute(attribute)
          .split(/\s+/)
          .map((id) => (nodes.has(id) ? domId(id) : id))
          .join(' '),
      );
    }
    const href = element.getAttribute('href');
    if (href?.startsWith('#') && nodes.has(href.slice(1)))
      element.setAttribute('href', `#${domId(href.slice(1))}`);
    // Radios without a form owner otherwise form one group across all dialogs.
    if (element.matches('input[type="radio"][name]')) {
      element.dataset.panelName = element.name;
      element.name = domId(element.name);
    }
  }
  // New controller-created fields use domId too. Do not fall back to a primary
  // node when a logical ID is absent from this instance.
  const getElement = (id) =>
    nodes.get(id) ||
    root.querySelector(`#${CSS.escape(domId(id))}`) ||
    root.ownerDocument.getElementById(domId(id));
  return { root, getElement, domId };
}
