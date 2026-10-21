import './style.css';

// Auth gate: without the bypass flag this throws before anything renders (white page),
// just like apps that need real login env vars.
if (import.meta.env.VITE_NO_ENTRA_LOGIN !== 'true') {
  throw new Error('Missing Entra authentication environment variables');
}

const pages = {
  '/': ['Home', 'Welcome to the fixture app'],
  '/insights/dashboards': ['Dashboards', 'Deep route: assets must load from the site root'],
  '/settings': ['Settings', 'A third page'],
};
const [title, body] = pages[location.pathname] || ['Not found', ''];
document.getElementById('app').innerHTML = `
  <header><b>Fixture</b><nav><a href="/">Home</a> <a href="/insights/dashboards">Dashboards</a> <a href="/settings">Settings</a></nav></header>
  <main><h1>${title}</h1><p>${body}</p><div class="cards"><div>One</div><div>Two</div><div>Three</div></div></main>
  ${localStorage.getItem('welcome-seen') === 'true' ? '' : '<div class="modal"><div class="box"><div>Welcome! Take a tour?</div><button id="tour">Start tour</button> <button id="skip">Skip for now</button></div></div>'}`;

document.getElementById('skip')?.addEventListener('click', () => { localStorage.setItem('welcome-seen', 'true'); document.querySelector('.modal').remove(); });
