const server = process.env.WOZ_SERVER || 'http://localhost:8788';
const frontend = process.env.WOZ_FRONTEND || `${server}/public/`;
const response = await fetch(new URL('/sessions',server), { method:'POST',headers: process.env.ADMIN_TOKEN ? {Authorization:`Bearer ${process.env.ADMIN_TOKEN}`} : {} });
if (!response.ok) throw new Error(`Create session failed: ${response.status}`);
const session = await response.json();
for (const role of ['participant','wizard']) {
  const url = new URL(frontend); url.hash = new URLSearchParams({server,session:session.session,role,token:session.tokens[role]}).toString();
  console.log(`${role}: ${url}`);
}
