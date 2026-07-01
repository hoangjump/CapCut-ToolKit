const db = require('better-sqlite3')('node_modules/camoufox-js/dist/data-files/webgl_data.db', { readonly: true });
for (const os of ['win','mac','lin']) {
  const rows = db.prepare(`SELECT vendor, renderer FROM webgl_fingerprints WHERE ${os} > 0 ORDER BY ${os} DESC`).all();
  console.log(`\n=== ${os} (${rows.length}) ===`);
  for (const r of rows) console.log(`${r.vendor}  |  ${r.renderer}`);
}
