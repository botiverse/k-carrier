// Shared chrome for the K docs: sidebar navigation, current-page marker,
// mobile menu toggle and heading anchors. Pages stay plain HTML without it.
(() => {
  const NAV = [
    ['Read in order', [
      ['index.html', 'Overview'],
      ['guide.html', 'How an upgrade works'],
      ['example.html', 'Runnable example'],
      ['integration.html', 'Integration and distribution'],
    ]],
    ['Contracts', [
      ['design.html', 'Design'],
      ['reference.html', 'Reference'],
      ['test-plan.html', 'Test plan'],
      ['harness-design.html', 'Harness design'],
      ['formal.html', 'Formal model'],
    ]],
    ['Background', [
      ['prior-art.html', 'Prior art and research'],
    ]],
  ];
  const here = location.pathname.split('/').pop() || 'index.html';
  const nav = document.getElementById('nav');
  if (nav) {
    nav.innerHTML = NAV.map(([group, items]) =>
      `<h2>${group}</h2><ul>${items.map(([href, label]) =>
        `<li><a href="${href}"${href === here ? ' aria-current="page"' : ''}>${label}</a></li>`).join('')}</ul>`
    ).join('') + `<p class="meta">K 0.2.0 · <a href="https://github.com/botiverse/k-carrier">GitHub</a></p>`;
  }
  const btn = document.querySelector('.menu-btn');
  if (btn && nav) {
    btn.addEventListener('click', () => {
      const open = nav.toggleAttribute('data-open');
      btn.setAttribute('aria-expanded', String(open));
    });
  }
  for (const h of document.querySelectorAll('main h2[id], main h3[id]')) {
    const a = document.createElement('a');
    a.className = 'anchor'; a.href = `#${h.id}`; a.textContent = '#'; a.setAttribute('aria-label', 'Link to this section');
    h.append(a);
  }
})();
