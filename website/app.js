const root = document.body;
const themeButton = document.querySelector('.theme-toggle');
const navButton = document.querySelector('.nav-toggle');
const nav = document.querySelector('.site-nav');

function setTheme(theme) {
  root.classList.toggle('dark', theme === 'dark');
  localStorage.setItem('ai-load-balancer-theme', theme);
  themeButton?.setAttribute('aria-label', theme === 'dark' ? 'Use light theme' : 'Use dark theme');
}

const savedTheme = localStorage.getItem('ai-load-balancer-theme');
setTheme(savedTheme || 'light');
themeButton?.addEventListener('click', () => setTheme(root.classList.contains('dark') ? 'light' : 'dark'));
navButton?.addEventListener('click', () => {
  const open = nav?.classList.toggle('open') ?? false;
  navButton.setAttribute('aria-expanded', String(open));
});
nav?.querySelectorAll('a').forEach((link) => link.addEventListener('click', () => { nav.classList.remove('open'); navButton?.setAttribute('aria-expanded', 'false'); }));

document.querySelectorAll('[data-port]').forEach((node) => { node.textContent = '42891'; });
const sectionLabels = [['#why .eyebrow', '02 — Why it works'], ['#protocols .eyebrow', '03 — Drop-in by design'], ['#quickstart .eyebrow', '04 — Made for momentum'], ['#download .eyebrow', '05 — Ready when you are']];
sectionLabels.forEach(([selector, label]) => { const node = document.querySelector(selector); if (node) node.textContent = label; });
const heroDownload = document.querySelector('.hero-actions .button-gold');
if (heroDownload) heroDownload.firstChild.textContent = 'Download for Windows ';
const releaseVersion = document.querySelector('.release-meta span:nth-child(2)');
if (releaseVersion) releaseVersion.textContent = 'Windows x64';
